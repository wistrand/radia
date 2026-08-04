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
