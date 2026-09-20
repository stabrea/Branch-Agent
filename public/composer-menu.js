/** batch2-composer: toggle the plus button menu */
(function() {
  const button = document.getElementById("composer-plus");
  const menu = document.getElementById("composer-plus-menu");

  if (!button || !menu) return;

  // Toggle menu visibility
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = button.getAttribute("aria-expanded") === "true";
    setMenuOpen(!isOpen);
  });

  // Close menu when clicking outside
  document.addEventListener("click", (event) => {
    if (!button.contains(event.target) && !menu.contains(event.target)) {
      setMenuOpen(false);
    }
  });

  // Close menu when pressing Escape
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && button.getAttribute("aria-expanded") === "true") {
      setMenuOpen(false);
      button.focus();
    }
  });

  function setMenuOpen(open) {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    menu.hidden = !open;
    if (open) {
      menu.focus();
    }
  }

  // Close menu when clicking menu items
  menu.addEventListener("click", () => {
    setMenuOpen(false);
  });
})();
