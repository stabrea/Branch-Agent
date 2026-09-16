// The phone's side of "reach Branch from my phone": type the number shown on the computer, and this
// page asks Branch for the key that lets the app work. Nothing is stored beyond this browser tab.
"use strict";
var form = document.getElementById("pair-form");
var field = document.getElementById("code");
var button = document.getElementById("submit");
var message = document.getElementById("message");
var offerId = new URLSearchParams(location.search).get("id") || "";

function say(text, bad) {
  message.textContent = text;
  message.className = bad ? "bad" : "";
}

if (!offerId) say("This link is incomplete. Open the square code on your computer again.", true);

form.addEventListener("submit", function (event) {
  event.preventDefault();
  button.disabled = true;
  say("Connecting…", false);
  fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: offerId, code: field.value.trim() }),
  })
    .then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || "That did not work.");
        return body;
      });
    })
    .then(function (body) {
      try {
        sessionStorage.setItem("branch-token", body.token);
      } catch (error) {
        say("This browser will not let the page remember anything, so it cannot stay connected.", true);
        return;
      }
      say("Connected. Opening Branch…", false);
      location.replace("/");
    })
    .catch(function (error) {
      say(error.message, true);
      button.disabled = false;
      field.value = "";
      field.focus();
    });
});
