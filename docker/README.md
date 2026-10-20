# Deployment recipes

Each directory is a Compose stack with its own README: `keycloak/` (an OIDC issuer), `s3/` (an
object store for artifact bytes), `py-parity/` (pinned Pythons for the SDK parity suite),
`cluster/` (primary, standby and S3 for `bench/cluster/`), `jaeger/` (an OTLP collector for
`radia otlp`) and `postgres/`.

## Networks that collide with a VPN

The compose files pin no subnet, so Docker allocates each stack's bridge from its default pool
(172.17.0.0/16 upward). A VPN that routes 172.16.0.0/12 shadows those bridges: containers become
unreachable while the VPN is up, or a pushed route captures a container IP. A subnet pinned in a
compose file only moves the collision to whoever has that range on their LAN, so fix it in the
daemon instead, once per machine:

```sh
sudo mkdir -p /etc/docker      # optional file; most packages ship without it
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "bip": "10.200.0.1/24",
  "default-address-pools": [{ "base": "10.200.0.0/16", "size": 24 }]
}
EOF
sudo systemctl restart docker
```

`bip` moves `docker0`; the pool covers every network compose creates. Pick a base that neither
your LAN nor the VPN routes (check `ip route` with the VPN connected). Existing networks keep their
old subnets until recreated: `docker compose down && docker compose up -d` per stack, then
`docker network prune`.
