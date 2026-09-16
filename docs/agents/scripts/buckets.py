# Every remaining item, grouped so one bucket = one job, ordered by what makes Branch better to use.
# (title, why it matters, [keys]) where key is "<issue>:<id>".
BUCKETS = [
 ("Real sandboxes, and other computers over SSH",
  "Today a script runs on this computer as you, held to memory and processor limits but not in a box. This puts Docker, WSL or Windows Sandbox behind it where you have one, and lets Branch work on another machine you already log in to.",
  ["80:A2131","80:A2152","80:A2160","80:A0018","80:A1520","80:A1618","80:A0797","80:A1770","80:A2028","80:A1413",
   "87:A0329","87:A0648","87:A2279","87:A0544","87:A1582","66:A2027","66:A2233","66:A2344","66:A0365",
   "55:FAMILY:sandbox-execution","73:FAMILY:sandboxing","73:A2406"]),

 ("Writing real documents, not only reading them",
  "Branch reads Word, Excel and PowerPoint. It cannot write one yet. This is the difference between an assistant that answers and one that hands you the finished thing.",
  ["57:A2145","57:A2263","57:A2264","57:A0946","57:A1668","57:A1867","57:A2362","57:A2036","57:A0994",
   "57:A1013","57:A1144","57:A1426","57:A2343","57:FAMILY:doc-processing","76:A2265","76:A2025","76:FAMILY:media-gen"]),

 ("Flows that really run as a graph",
  "Flows exist as pictures and run in order. Twenty-odd rows of the audit all describe the same missing thing: branches, loops, sub-graphs and state, so a long job survives something failing halfway through.",
  ["55:A0778","55:A0889","55:A0890","55:A0892","55:A0907","55:A0978","55:A0981","55:A1112","55:A1168","55:A1215",
   "55:A1238","55:A1257","55:A1292","55:A1337","55:A1338","55:A0318","55:A0827","55:A0808","55:A1270","55:A1340",
   "60:A1274","60:A0834","55:A1313","55:A0904","55:FAMILY:workflow-hooks"]),

 ("Plan first, show me the plan, then act",
  "The thing people want most from an agent: see what it intends before it does it, and change it. Asking permission per tool is not the same as agreeing a plan.",
  ["55:A0110","55:A0405","78:A0468","58:A0605","55:A0538","60:A0279","60:A0624"]),

 ("It gets better the more you use it",
  "Memory built from what you actually do, a knowledge base that grows from facts you accept, and a plain-text mirror you can read and edit yourself.",
  ["74:A0650","74:A1926","74:A1989","74:A2185","74:A1117","74:A1425","74:A1475","74:A2168","60:A1979","60:A1976"]),

 ("A second opinion before it commits",
  "An advisor model that checks the answer, two models arguing a hard question, and replies forced into a shape the rest of the app can rely on.",
  ["55:A0195","55:A0408","67:A0813","78:A0728","60:A1410","55:FAMILY:adapter-system"]),

 ("Answers that carry their sources, over your own material",
  "Retrieval that can be filtered and reranked, and a choice of where the vectors live, so a large personal library stays fast and quotable.",
  ["60:A1745","60:A0840","75:A0784","75:A0947","75:A1103","75:A1328","75:A1921","75:A2363",
   "82:FAMILY:context-providers","82:A1269","82:A0353"]),

 ("Long jobs that survive being interrupted",
  "Threads that persist, work that carries on with the window closed, a terminal session alive between tasks, and a way to run the whole thing with no window at all.",
  ["60:A0390","60:A2243","60:A2315","60:A2377","89:A1657","89:A1378"]),

 ("Faster and cheaper on the same work",
  "Batch requests where a service offers them, and answers reused when the same question comes round again.",
  ["60:A1351","60:A1352","60:A0928","60:A0847"]),

 ("A browser that copes with real websites",
  "Pages marked up so the model can point at exactly the right thing, and skills for the handful of sites a person actually uses.",
  ["62:A2144","62:A1568","62:A2172","62:A2019","62:A2042","62:FAMILY:doc-processing",
   "62:FAMILY:document-processing","91:A0743","64:A1452"]),

 ("Proof it still works, and proof it got better",
  "Ready-made sets of tasks you can run at any time to see how many it gets right, what it cost, and whether anything that used to work has stopped.",
  ["61:A0374","61:A0858","61:A0927","61:A0973","61:A1210","61:A1231","61:A1499","61:A1726","61:A1731","61:A1736",
   "61:A1752","61:A1753","61:A1766","88:A1082"]),

 ("Your own saved prompts, skills and procedures",
  "A library of the things you ask for often, installable while Branch is running, with somewhere to write one and try it out.",
  ["78:A1882","60:A2001","78:A0776","78:A2374","78:A0147","72:FAMILY:custom-commands","78:FAMILY:examples"]),

 ("Seeing what it did, step by step, afterwards",
  "A recording of the run you can replay, a picture of the path it took, and the event log behind both.",
  ["58:A0295","60:A1561","60:A1589","77:A1696","77:A1697","77:FAMILY:capture","63:A1931","58:A0798","58:A1637",
   "58:A1677","58:A0500","58:FAMILY:diagnostics-logging"]),

 ("What it has cost you, in plain figures",
  "Usage that answers what you are spending and on what, without a spreadsheet.",
  ["58:A0367","58:A0400","63:A1751","63:A0681","63:A1334"]),

 ("Add-ons other people wrote",
  "Plugins and extensions you can find, install and switch off again, with the permissions each one needs shown before you say yes.",
  ["70:FAMILY:extensions","70:FAMILY:plugin-marketplace","70:FAMILY:extension-packages","70:FAMILY:filter-system",
   "70:FAMILY:pipeline-integration","70:FAMILY:claude-integration","92:FAMILY:claude-integration","60:A0602"]),

 ("The rest of the chat apps",
  "The services the audit lists that Branch still has no adapter for.",
  ["59:A2066","59:A2117","59:A2156","59:A2349","59:FAMILY:channel-adapter","59:FAMILY:messaging-channel",
   "59:FAMILY:webhooks"]),

 ("Pictures, video and sound it can take in",
  "Attach a video or a sound file and have it understood rather than merely listed.",
  ["65:A0888","65:A2068","65:A2162","65:FAMILY:model-provider","65:FAMILY:voice","65:FAMILY:content-fetching",
   "76:A2174","67:A0969","60:A1193","55:FAMILY:multimodal-input"]),

 ("Working with code it did not write",
  "A map of an unfamiliar project, a check that the change compiles, and a small editor for the fix.",
  ["81:A0537","81:A2359","81:A1183","86:A2128","60:A0098","60:A0344",
   "84:A0435","84:A2317","84:FAMILY:integrations","60:A0300","60:A0174"]),

 ("More than one person, safely",
  "Sharing a conversation, a team view, and a way in that is not one local key, for the household case that already half exists.",
  ["90:A0366","90:A1901","90:A2212","64:A1984","69:A1003","69:A1004","69:A1804","69:A1897","69:A2003","69:A2074",
   "69:A2095","69:A2216","69:A0686","69:A1807","66:A1005","67:A1187","60:A0323"]),

 ("Talking to other agents and tools",
  "The open protocols, so Branch can be one part of somebody else's setup and they can be part of yours.",
  ["67:FAMILY:agent-protocol","67:FAMILY:client-tools","67:A0429","67:A1857","55:FAMILY:provider-actions",
   "55:A0146","55:A0319","55:A0688","55:A0428","55:A1293","55:A1327","55:A0421"]),

 ("A library other people can build on",
  "A Python client and a published package, so somebody can drive Branch from their own program.",
  ["73:FAMILY:sdk-python","60:A1509","55:FAMILY:framework-adapters","64:FAMILY:sdk-react","64:FAMILY:app-building",
   "85:A2353","60:A0758","73:FAMILY:serialization"]),

 ("Installing it should be boring",
  "A signed installer, a first run that works, and the same experience on a second machine.",
  ["73:FAMILY:installers","73:FAMILY:desktop-packaging","73:FAMILY:platform-support","73:FAMILY:distributions"]),

 ("The smaller asks",
  "Each half a day on its own, but they add up: project bookkeeping, an artifact you can edit, source sync and the leftovers.",
  ["60:A0794","60:A2334","85:A0612","85:A2221","85:A1895","85:FAMILY:examples","85:FAMILY:integration-blocks",
   "60:A0355","60:A0354","60:A2375","56:A1012","56:A2258","77:A0032","77:A0601","77:A0464","77:A2043",
   "55:FAMILY:research-pipeline","55:FAMILY:gateway","88:A0504","63:A1620","60:A1611","64:A2240","64:A2133",
   "64:A1932","64:A1934","56:A2367"]),
]

NOT_APPLICABLE = [
 ("Other projects' demo interfaces",
  "Gradio, Streamlit, Chainlit, Next.js and similar sample front ends, plus a desktop pet. Branch has its own window and its own web page; a second one in somebody else's framework would be a worse copy with more to go wrong.",
  ["64:A0080","64:A0401","64:A0419","64:A0527","64:A0704","64:A0956","64:A1131","64:A1192","64:A1435","64:A1536",
   "64:A1676","64:A1774","64:A2015","64:A2033","64:A2157","64:A2198","64:A2200","64:A1905","64:A2197","64:A1585",
   "60:A1011","60:A1749"]),
 ("Companion apps for other operating systems",
  "macOS, iOS and Android applications, and an Android device bridge. Branch is a Windows desktop assistant, and reaching it from a phone already works through the paired address and the installable web page.",
  ["77:A1775","77:A1776","87:A1777","87:A2080","60:A1468","60:A0663"]),
 ("Somebody else's service in the middle",
  "LiteLLM in front of the providers, RAGFlow as a knowledge service, and Sentry for crash reports. Each adds a process to run and a place your data can sit. Branch reaches the same services directly, on one computer, and crashes are written down locally.",
  ["60:A1141","63:A0566"]),
]
