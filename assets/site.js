/* Beehive Bin Co. — shared page behavior (nav toggle, footer year). */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('.menu-btn');
  const nav = document.querySelector('.site-nav');
  if (btn && nav) {
    btn.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
});
