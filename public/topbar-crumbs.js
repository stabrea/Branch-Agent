/* DG-099: the top bar says where you are, as the approved sample does: the face of the computer or Trunk you are on,
   its name, "/", and then the conversation's own title ("New conversation" before its first message) or the place's
   name. On a phone the name and the "/" give way.

   The face, the name and the "/" are the crumb public/layout.js builds (buildCrumb, DG-141), so there is one crumb
   in every place. This file gives a conversation its title: the place's heading (#page-title) keeps its words for a
   screen reader, and the visible title is the conversation's (#thread-name), which public/app.js and public/rooms.js
   already keep up to date. Before its first message it reads "New conversation". Words have data-t keys; no colour
   is written here. */
import { say } from "/strip.js";

const $ = (id) => document.getElementById(id);

function nameNewConversation() {
  const thread = $("thread-name");
  if (!thread) return;
  thread.dataset.tEmpty = "composer.new";
  thread.dataset.empty = say("composer.new", "New conversation");
}

nameNewConversation();
document.addEventListener("branch-language", nameNewConversation);
