// The connect screen. window.aatmiqDesktop comes from connect-preload.ts.
const form = document.getElementById("form");
const input = document.getElementById("address");
const error = document.getElementById("error");
const go = document.getElementById("go");

function show(state) {
  if (!state) return;
  if (state.server && !input.value) input.value = state.server;
  error.hidden = !state.error;
  error.textContent = state.error || "";
}

window.aatmiqDesktop.state().then(show);
window.aatmiqDesktop.onState(show);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  go.disabled = true;
  go.textContent = "Connecting…";
  error.hidden = true;
  const r = await window.aatmiqDesktop.connect(input.value);
  if (!r.ok) {
    error.textContent = r.error;
    error.hidden = false;
    go.disabled = false;
    go.textContent = "Connect";
    input.focus();
  }
});
