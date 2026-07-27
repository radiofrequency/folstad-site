const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Active section for nav */
const navLinks = document.querySelectorAll<HTMLAnchorElement>("[data-nav-link]");
const sections = Array.from(document.querySelectorAll<HTMLElement>("main section[id]"));

function setActive(id: string) {
  navLinks.forEach((link) => {
    const href = link.getAttribute("href") ?? "";
    const active = href === `#${id}`;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  });
}

if (sections.length && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible[0]?.target?.id) setActive(visible[0].target.id);
    },
    { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
  );
  sections.forEach((s) => observer.observe(s));
}

/* Soft reveal */
if (!reduceMotion && "IntersectionObserver" in window) {
  const reveals = document.querySelectorAll<HTMLElement>(".reveal");
  const ro = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          ro.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  reveals.forEach((el) => ro.observe(el));
} else {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible"));
}

/* Mobile nav toggle */
const toggle = document.querySelector<HTMLButtonElement>("[data-nav-toggle]");
const menu = document.querySelector<HTMLElement>("[data-nav-menu]");

toggle?.addEventListener("click", () => {
  const open = menu?.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
});

menu?.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    menu.classList.remove("is-open");
    toggle?.setAttribute("aria-expanded", "false");
  });
});
