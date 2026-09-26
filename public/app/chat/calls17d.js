/* Pass 17 part D §2: phone calls and meeting notes, 1:1 with the prototype's patch17d.js and all greyed. A phone call
   needs the owner's own Twilio number and account, and a meeting bot needs a service that joins Meet, Teams or Zoom as a
   guest; Branch has neither, so no call, meeting, live view or result card can happen. Both would ship off anyway
   (calls cost by the minute and reach people outside Branch; the meeting bot listens to everyone there). Drawn: the
   message box's + menu items, saying "off", and Settings › Voice › Calls and meetings at Advanced, every switch off and
   no choice pressed. None of call17d, meet17d or the cmsw17d switches has a handler, so each greys itself. */

import { esc } from "../core/dom.js";
import { mi } from "../core/ui.js";
import { ctlSeg } from "../settings/parts.js";

/** The + menu's two items, after the rest. */
export const plus17d = () => "<hr>" + mi("call17d", "call17d", "Phone call…", "off") + mi("meet17d", "meet17d", "Join a meeting…", "off");

const sw = (v, title, sub) => `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" data-sw="cmsw17d" data-v="${v}" aria-label="${esc(title)}"><small>${esc(sub)}</small></div>`;

/** Settings › Voice, at Advanced. */
export function calls17d() {
  const rows = sw("call", "Phone calls", "Call you, or call someone for you. Off until you choose: calls cost money by the minute and reach people outside Branch.")
    + `<div class="ctl"><b>Calling from</b><span class="right"><button class="btn sm" type="button" data-act="call17d">Set up</button></span><small>Your Twilio number. Its key is in the locker.</small></div>`
    + ctlSeg("Who it may call", "Numbers you approve once, or anyone you name in a message.", ["People I approve", "Anyone I name"], null)
    + ctlSeg("Recording", "It always says first that it’s an AI assistant calling for you.", ["Only if they agree", "Never"], null)
    + sw("meet", "Meeting notes", "A Trunk joins Meet, Teams or Zoom as a guest and brings the notes back. Off until you choose: it listens to everyone there.")
    + ctlSeg("Join from your calendar", "It never joins a meeting by itself unless you pick the second.", ["Only when I ask", "Meetings I’m invited to"], null)
    + ctlSeg("Send notes afterwards", "Sending to other people asks you first.", ["To me", "To everyone there"], null);
  return `<div class="sec x15-sec"><h2>Calls and meetings</h2><p class="hint">Phone calls go through your own Twilio number; meeting notes use your connected calendar.</p>${rows}</div>`;
}
