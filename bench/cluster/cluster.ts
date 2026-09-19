// A throwaway Radia cluster: N `radia serve` over one Postgres primary with a streaming standby, a
// shared S3 bucket and one shared KEK (agent_docs/plan-cluster-bench.md, phase 0).
//
// Containers come from `docker/cluster/compose.yaml` under a project name unique to this run, so a
// crashed run never reuses another's state and `down` removes exactly what `up` made. The instances
// run on the host from the checkout, so a run measures the working tree, and they reach Postgres
// through `PgProxy`, the endpoint a failover moves.
//
// Instances start ONE AT A TIME: the first creates the schema, and concurrent `create … if not
// exists` DDL from several processes can collide in the catalog.

import { Client } from "@db/postgres";
import { RadiaClient } from "../../sdk/ts/client.ts";
import { parseS3Spec, S3BlobStore } from "../../src/storage/s3.ts";
import { BlobCipher } from "../../src/storage/crypto.ts";
import { PgProxy, type Target } from "./pgproxy.ts";

// TCP_NODELAY on the harness's own Postgres connections. deno-postgres 0.19 never sets it, so each
// parameterized query stalls ~40ms on Nagle plus delayed ACK; the runtime patches `Deno.connect` for
// the same reason (`enableTcpNoDelay`, src/storage/postgres.ts, not exported). Without this the
// harness's reads and its proxy-latency check measure the driver's stall instead of the database.
{
  const original = Deno.connect.bind(Deno);
  Object.defineProperty(Deno, "connect", {
    configurable: true,
    value: async (opts: Deno.ConnectOptions): Promise<Deno.Conn> => {
      const conn = await original(opts);
      try {
        (conn as Deno.TcpConn).setNoDelay(true);
      } catch { /* not TCP */ }
      return conn;
    },
  });
}

const ROOT = new URL("../../", import.meta.url).pathname;
const COMPOSE = `${ROOT}docker/cluster/compose.yaml`;
const S3_KEYS = { RADIA_S3_ACCESS_KEY_ID: "radialocal", RADIA_S3_SECRET_ACCESS_KEY: "radialocal" };

export interface ClusterOptions {
  instances: number;
  /** Synchronous replication (the default). False is the async control arm. */
  sync?: boolean;
  /** First instance port; instance i listens on basePort + i. */
  basePort?: number;
  log?: (line: string) => void;
}

export interface Instance {
  index: number;
  port: number;
  url: string;
  /** This process's operator token. Operator tokens live in memory, so it changes on restart. */
  token: string;
  logPath: string;
  child?: Deno.ChildProcess;
}

async function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const out = await new Deno.Command(cmd, { args, env, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout).trim();
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")} failed:\n${new TextDecoder().decode(out.stderr)}`);
  return text;
}

/** `127.0.0.1:49153` from `docker compose port`. */
function target(hostPort: string): Target {
  const i = hostPort.lastIndexOf(":");
  return { hostname: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Cluster {
  readonly instances: Instance[] = [];

  private constructor(
    readonly project: string,
    readonly workDir: string,
    readonly sync: boolean,
    readonly primary: Target,
    readonly standby: Target,
    readonly proxy: PgProxy,
    readonly blobSpec: string,
    private readonly kek: string,
    private readonly log: (line: string) => void,
  ) {}

  /** Bring everything up, or tear down what came up and throw. */
  static async up(opts: ClusterOptions): Promise<Cluster> {
    const log = opts.log ?? (() => {});
    const sync = opts.sync !== false;
    const project = `radia-cluster-${Deno.pid}-${Date.now().toString(36)}`;
    const workDir = await Deno.makeTempDir({ prefix: "radia-cluster-" });
    const compose = (...args: string[]) => run("docker", ["compose", "-p", project, "-f", COMPOSE, ...args]);

    let cluster: Cluster | undefined;
    try {
      log(`compose up (${project}, ${sync ? "sync" : "ASYNC"} standby)`);
      await compose("up", "-d", "--wait");
      const primary = target(await compose("port", "pg-primary", "5432"));
      const standby = target(await compose("port", "pg-standby", "5432"));
      const s3 = target(await compose("port", "s3", "8333"));
      const blobSpec = `s3://radia/cluster?endpoint=http://${s3.hostname}:${s3.port}`;
      // The space never creates its bucket (docker/s3/README.md); the harness does, as the S3
      // conformance run does.
      await new S3BlobStore(parseS3Spec(blobSpec, (k) => (S3_KEYS as Record<string, string>)[k])).ensureBucket();
      const proxy = PgProxy.start(primary);
      const kek = b64(crypto.getRandomValues(new Uint8Array(32)));
      cluster = new Cluster(project, workDir, sync, primary, standby, proxy, blobSpec, kek, log);
      await cluster.waitForStandby();
      for (let i = 0; i < opts.instances; i++) await cluster.startInstance(i, opts.basePort ?? 7950);
      return cluster;
    } catch (e) {
      if (cluster) await cluster.down().catch(() => {});
      else {
        await compose("down", "-v", "--remove-orphans").catch(() => {});
        await Deno.remove(workDir, { recursive: true }).catch(() => {});
      }
      throw e;
    }
  }

  get urls(): string[] {
    return this.instances.map((i) => i.url);
  }

  /** One operator client per instance, each holding that instance's own token. */
  admins(): RadiaClient[] {
    return this.instances.map((i) => new RadiaClient(i.url, { token: i.token }));
  }

  /** A direct connection string, bypassing the proxy: for the harness's own reads. */
  pgUrl(t: Target = this.primary): string {
    return `postgres://radia:radia@${t.hostname}:${t.port}/radia`;
  }

  /** One statement on a fresh connection, the primary unless `on` says otherwise. */
  async sql<T>(query: string, opts: { params?: unknown[]; on?: Target } = {}): Promise<T[]> {
    const c = new Client(this.pgUrl(opts.on ?? this.primary));
    await c.connect();
    try {
      return (await c.queryObject<T>(query, opts.params ?? [])).rows;
    } finally {
      await c.end();
    }
  }

  /** The instances' blob store as they see it: the bucket, sealed under the shared KEK. For a planted
   *  fault only; the benchmark reads bytes through the instances. */
  async blobStore(): Promise<S3BlobStore> {
    const cipher = await BlobCipher.fromKey(Uint8Array.from(atob(this.kek), (c) => c.charCodeAt(0)));
    return new S3BlobStore(parseS3Spec(this.blobSpec, (k) => (S3_KEYS as Record<string, string>)[k]), cipher);
  }

  /** What the primary reports about its standbys. */
  replication(): Promise<{ application_name: string; state: string; sync_state: string }[]> {
    return this.sql("select application_name, state, sync_state from pg_stat_replication");
  }

  /** Switch replication mode on a running primary: `alter system` plus a reload, no restart. In sync
   *  mode a commit waits for `standby1`, so this is only safe while the standby streams. */
  async setSync(sync: boolean): Promise<void> {
    await this.sql(`alter system set synchronous_standby_names = '${sync ? "standby1" : ""}'`);
    await this.sql("select pg_reload_conf()");
    await this.waitForState(sync ? "sync" : "async");
  }

  /** Until the standby streams, then in the mode this cluster was asked for. The primary starts
   *  asynchronous (docker/cluster/compose.yaml says why), so sync is switched on here. */
  async waitForStandby(): Promise<void> {
    await this.waitForState("async");
    if (this.sync) await this.setSync(true);
  }

  private async waitForState(want: "sync" | "async", timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const rows = await this.replication().catch(() => []);
      if (rows.some((r) => r.state === "streaming" && r.sync_state === want)) return;
      await sleep(250);
    }
    throw new Error(`standby not streaming as ${want} after ${timeoutMs}ms: ${JSON.stringify(await this.replication().catch(() => []))}`);
  }

  async startInstance(index: number, basePort = this.instances[0]?.port ?? 7950): Promise<Instance> {
    const port = this.instances[index]?.port ?? basePort + index;
    const tokenFile = `${this.workDir}/op${index}`;
    const logPath = `${this.workDir}/serve${index}.log`;
    await Deno.remove(tokenFile).catch(() => {});
    const child = new Deno.Command("deno", {
      args: [
        "run", "-A", `${ROOT}src/main.ts`, "serve",
        "--storage", "postgres", "--db", `postgres://radia:radia@127.0.0.1:${this.proxy.port}/radia`,
        "--port", String(port), "--blobs", this.blobSpec, "--artifact-port", "0",
        "--operator-token-file", tokenFile, "--log-level", "warn",
      ],
      cwd: this.workDir,
      env: { ...S3_KEYS, RADIA_BLOB_KEK: this.kek, RADIA_DIR: `${this.workDir}/radia${index}`, RADIA_CREDENTIALS: `${this.workDir}/credentials.json` },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // Both streams into one file, appended, so a restart keeps the previous life's log above it.
    const open = () => Deno.open(logPath, { write: true, create: true, append: true });
    child.stdout.pipeTo((await open()).writable).catch(() => {});
    child.stderr.pipeTo((await open()).writable).catch(() => {});

    const url = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    let exited = false;
    child.status.then(() => exited = true);
    while (Date.now() - t0 < 60_000 && !exited) {
      const token = await Deno.readTextFile(tokenFile).then((t) => t.trim(), () => "");
      const healthy = token !== "" && await fetch(`${url}/v0/health`).then((r) => (r.body?.cancel(), r.ok), () => false);
      if (healthy) {
        const inst: Instance = { index, port, url, token, logPath, child };
        this.instances[index] = inst;
        this.log(`instance ${index} up on ${url}`);
        return inst;
      }
      await sleep(250);
    }
    if (!exited) child.kill("SIGKILL");
    await child.status;
    throw new Error(`instance ${index} did not start; ${logPath}:\n${await Deno.readTextFile(logPath).catch(() => "")}`);
  }

  /** SIGTERM (or the signal given), escalating to SIGKILL after 10s. */
  async stopInstance(index: number, signal: Deno.Signal = "SIGTERM"): Promise<Deno.CommandStatus | undefined> {
    const child = this.instances[index]?.child;
    if (!child) return undefined;
    try {
      child.kill(signal);
    } catch { /* already exited */ }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* exited meanwhile */ }
    }, 10_000);
    const status = await child.status;
    clearTimeout(timer);
    this.instances[index].child = undefined;
    return status;
  }

  /** Stop every instance, the proxy and the containers, and delete the work directory. Every step
   *  runs even when an earlier one fails, and the failures are thrown together at the end. */
  async down(): Promise<void> {
    const errors: string[] = [];
    await Promise.all(this.instances.map((_, i) => this.stopInstance(i).catch((e) => errors.push(`instance ${i}: ${e}`))));
    this.proxy.close();
    await run("docker", ["compose", "-p", this.project, "-f", COMPOSE, "down", "-v", "--remove-orphans"]).catch((e) => errors.push(`compose down: ${e}`));
    await Deno.remove(this.workDir, { recursive: true }).catch((e) => errors.push(`work dir: ${e}`));
    this.log(`down (${this.project})`);
    if (errors.length) throw new Error(errors.join("\n"));
  }
}
