/* Dense illustrations are summaries first on narrow screens. The full SVG remains one tap away. */
(function () {
  document.querySelectorAll('figure > svg').forEach(function (svg, index) {
    var figure = svg.parentElement;
    if (!figure || !figure.querySelector('figcaption')) return;

    var button = document.createElement('button');
    var diagramId = svg.id || 'docs-diagram-' + (index + 1);
    svg.id = diagramId;
    button.type = 'button';
    button.className = 'diagram-toggle';
    button.setAttribute('aria-controls', diagramId);
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'View diagram';
    figure.insertBefore(button, svg);

    button.addEventListener('click', function () {
      var open = figure.classList.toggle('diagram-open');
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Hide diagram' : 'View diagram';
    });
  });
})();

/* Sidebar scroll spy. Highlights the section currently under the top of the viewport. */
(function () {
  var links = document.querySelectorAll('.sidebar a');
  var sections = [];
  links.forEach(function (a) {
    var id = a.getAttribute('href').slice(1);
    var el = document.getElementById(id);
    if (el) sections.push({ el: el, link: a });
  });
  if (!sections.length) return;

  function update() {
    var scrollY = window.scrollY + 100;
    var active = sections[0];
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].el.offsetTop <= scrollY) active = sections[i];
    }
    links.forEach(function (a) { a.classList.remove('active'); });
    active.link.classList.add('active');
  }

  window.addEventListener('scroll', update, { passive: true });
  update();
})();
