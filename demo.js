// Drives the PetClinic decision demo. All state transitions live in demo-model.js.
import {
  approve,
  buildPackage,
  buildProposal,
  choose,
  currentPhase,
  initialState,
  reset,
} from "./demo-model.js";

const copyNode = document.getElementById("forge-copy");
const root = document.querySelector("[data-demo]");

const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const fmt = (value) => escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");

if (copyNode && root) {
  const copy = JSON.parse(copyNode.textContent).case;
  const p = copy.proposal;
  const options = [...root.querySelectorAll("[data-choice]")];
  const statusPill = root.querySelector("[data-decision-status]");
  const agentChose = root.querySelector("[data-agent-chose]");
  const proposalBox = root.querySelector("[data-proposal]");
  const approveButton = root.querySelector("[data-approve]");
  const approveHint = root.querySelector("[data-approve-hint]");
  const resetButton = root.querySelector("[data-reset]");
  const handoff = root.querySelector("[data-handoff]");
  const packageBox = root.querySelector("[data-package]");
  const phases = [...document.querySelectorAll("[data-phases] [data-phase]")];

  let state = initialState();

  const renderProposal = () => {
    const model = buildProposal(p, state);
    proposalBox.dataset.status = model.status;
    proposalBox.innerHTML = `
      <p class="proposal-status" data-proposal-status>${fmt(model.statusText)}</p>
      <div class="proposal-body">
        ${model.sections
          .map(
            (section) => `
        <section class="proposal-section" data-section="${section.key}">
          <h4>${fmt(section.title)}</h4>
          <ul>
            ${section.items
              .map((item) => {
                const cls = item.changed ? "is-changed" : item.unresolved ? "is-unresolved" : "";
                const mark = item.changed ? `<em class="changed-mark">${fmt(p.changedMark)}</em>` : "";
                return `<li${cls ? ` class="${cls}"` : ""}><span>${fmt(item.text)}</span>${mark}</li>`;
              })
              .join("")}
          </ul>
        </section>`,
          )
          .join("")}
      </div>`;
    approveButton.disabled = !model.canApprove;
    approveButton.hidden = model.status === "approved";
    approveHint.hidden = model.status !== "blocked";
  };

  const render = () => {
    options.forEach((button) => {
      const selected = button.dataset.choice === state.choice;
      button.setAttribute("aria-checked", String(selected));
      button.disabled = state.approved;
      button.tabIndex = selected || (!state.choice && button === options[0]) ? 0 : -1;
    });
    const statusKey = state.approved ? "locked" : state.choice ? "decided" : "pending";
    statusPill.textContent = copy.decision[statusKey];
    statusPill.dataset.state = statusKey;
    agentChose.hidden = !state.choice;

    const phase = currentPhase(state);
    phases.forEach((item, index) => {
      item.dataset.state = index < phase || state.approved ? "done" : index === phase ? "current" : "todo";
      if (index === phase) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });

    renderProposal();
    const pkg = buildPackage(p, state);
    handoff.hidden = !pkg;
    packageBox.textContent = pkg ? JSON.stringify(pkg, null, 2) : "";
    resetButton.hidden = !state.choice;
    root.dataset.state = statusKey;
  };

  options.forEach((button, index) => {
    button.addEventListener("click", () => {
      state = choose(state, button.dataset.choice);
      render();
    });
    // Radio-group keyboard behavior: arrows move and select.
    button.addEventListener("keydown", (event) => {
      const delta = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (!delta || state.approved) return;
      event.preventDefault();
      const next = options[(index + delta + options.length) % options.length];
      state = choose(state, next.dataset.choice);
      render();
      next.focus();
    });
  });

  approveButton.addEventListener("click", () => {
    state = approve(state);
    render();
    handoff.focus({ preventScroll: true });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    handoff.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  });

  resetButton.addEventListener("click", () => {
    state = reset();
    render();
    options[0].focus();
  });

  render();
}
