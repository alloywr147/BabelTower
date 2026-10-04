// Pull the bridge's OWN log lines (everything that is not the mirrored game
// console) out of a time window, so message traffic is readable without the
// [game] noise drowning it.
// Usage: node scripts/bridge_probe.js "2026-10-04 11:20:00" logs/bridge_msgs.txt
const fs = require("fs");

const from = process.argv[2] || "1970-01-01 00:00:00";
const out = process.argv[3] || "logs/bridge_msgs.txt";
const date = from.slice(0, 10);
const hhmmss = from.slice(11, 19);

const lines = fs.readFileSync("logs/bridge.log", "utf8").split(/\r?\n/);
const idx = lines.findIndex(
  (l) => l.startsWith("[" + date) && l.slice(12, 20) >= hhmmss
);
const region = idx < 0 ? lines.slice(-5000) : lines.slice(idx);

const bridge = region.filter(
  (l) => l.includes("]") && !l.includes("[game]") && l.trim().length
);
const game = region.filter((l) => l.includes("[game]"));

const tags = {};
for (const l of bridge) {
  const m = l.match(/\] \[([a-zA-Z0-9_.:-]+)\]/);
  const k = m ? m[1] : "(no-tag)";
  tags[k] = (tags[k] || 0) + 1;
}

fs.writeFileSync(
  out,
  [
    "### from=" + from,
    "### region=" + region.length + "  game=" + game.length + "  bridge=" + bridge.length,
    "### bridge tags: " + JSON.stringify(tags),
    "",
    "### bridge lines:",
    bridge.join("\n"),
  ].join("\n")
);
console.log(
  "region=" + region.length + " game=" + game.length +
  " bridge=" + bridge.length + " tags=" + JSON.stringify(tags)
);
