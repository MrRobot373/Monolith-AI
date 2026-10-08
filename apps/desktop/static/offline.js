// Shown when the server can't be reached. The app only lets "Try again" go to the Aatmiq server.
const q = new URLSearchParams(location.search);
const url = q.get("url") || "";
let host = "";
try {
  host = new URL(url).host;
} catch {}
document.getElementById("what").textContent = `${host || "The server"} didn't answer${q.get("error") ? ` (${q.get("error")})` : ""}.`;
document.getElementById("retry").setAttribute("href", /^https?:\/\//.test(url) ? url : "#");
