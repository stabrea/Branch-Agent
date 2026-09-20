/**
 * Hover-help control: an "i" button that shows help text on hover and in a popover on click.
 *
 * Usage:
 *   const button = infoDot({ id: "setting-id", label: "Setting name", text: "Help text here" });
 *   container.appendChild(button);
 *
 * Features:
 * - Shows nothing if text is missing (never an empty bubble)
 * - Hover reveals tooltip after 400ms with glass styling
 * - Click opens full text in a popover
 * - Keyboard focus shows tooltip
 * - Screen reader announces "About {label}"
 *
 * Requires: public/modal.js for popover functionality
 */

/**
 * Create an info dot button with hover tooltip and click popover
 * @param {Object} options - { id, label, text }
 * @returns {HTMLElement} button element, or null if text is missing
 */
export function infoDot({ id, label, text } = {}) {
  // Don't render if text is missing
  if (!text || !text.trim()) {
    return null;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "info-dot";
  button.textContent = "i";
  button.setAttribute("aria-label", `About ${label || id}`);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("data-id", id || "");

  let tooltipTimeout;
  let tooltip;

  /**
   * Show or update tooltip near the button
   */
  function showTooltip() {
    if (tooltip) return; // Already showing

    tooltip = document.createElement("div");
    tooltip.className = "info-tooltip";
    tooltip.role = "tooltip";
    tooltip.textContent = text;

    // Position near the button
    const rect = button.getBoundingClientRect();
    tooltip.style.position = "fixed";
    tooltip.style.top = (rect.top - 40) + "px";
    tooltip.style.left = (rect.left + rect.width / 2) + "px";
    tooltip.style.transform = "translateX(-50%)";
    tooltip.style.zIndex = "1000";

    document.body.appendChild(tooltip);
  }

  /**
   * Hide tooltip
   */
  function hideTooltip() {
    clearTimeout(tooltipTimeout);
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  }

  /**
   * Show popover on click
   */
  function showPopover() {
    // Close any existing popover
    hideTooltip();

    const popover = document.createElement("div");
    popover.className = "info-popover";
    popover.role = "dialog";
    popover.setAttribute("aria-label", `About ${label || id}`);

    const content = document.createElement("div");
    content.className = "info-popover-content";
    content.textContent = text;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "info-popover-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      popover.remove();
      button.focus();
    });

    const backdrop = document.createElement("div");
    backdrop.className = "info-popover-backdrop";
    backdrop.addEventListener("click", () => {
      popover.remove();
      button.focus();
    });

    popover.appendChild(backdrop);
    const container = document.createElement("div");
    container.className = "info-popover-container";
    container.appendChild(closeBtn);
    container.appendChild(content);
    popover.appendChild(container);

    document.body.appendChild(popover);

    // Focus the popover for keyboard accessibility
    popover.focus();

    // Close on Escape
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        popover.remove();
        button.focus();
        document.removeEventListener("keydown", handleEscape);
      }
    };
    document.addEventListener("keydown", handleEscape);
  }

  // Hover events - show tooltip after 400ms
  button.addEventListener("mouseenter", () => {
    tooltipTimeout = setTimeout(showTooltip, 400);
  });

  button.addEventListener("mouseleave", hideTooltip);

  // Click to show popover
  button.addEventListener("click", (e) => {
    e.preventDefault();
    showPopover();
  });

  // Keyboard support - Enter or Space to show popover
  button.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showPopover();
    }
  });

  // Focus events - show tooltip on focus
  button.addEventListener("focus", () => {
    tooltipTimeout = setTimeout(showTooltip, 400);
  });

  button.addEventListener("blur", hideTooltip);

  return button;
}

/**
 * Create multiple info dots for a list of descriptions
 * @param {Array} descriptions - Array of { id, label, text } objects
 * @returns {Array} Array of button elements (excluding null for missing text)
 */
export function infoDots(descriptions) {
  return descriptions
    .map(desc => infoDot(desc))
    .filter(btn => btn !== null);
}
