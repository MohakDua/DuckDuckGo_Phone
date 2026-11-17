/* DuckGoDo phone (Build 27). One file, no libraries, nothing but this page's own storage.
 *
 * WHAT THIS PAGE HOLDS: only a copy of what the laptop last uploaded (snapshot.json) plus your own changes that have not been merged yet,
 * both in this browser's localStorage. No keys, no secrets live in the page: the Google Client ID in config.js is a public name, and
 * the short-lived (1 hour) Google access token is kept in this browser only.
 *
 * HOW SYNC WORKS: every tap becomes a small change record {id, ts, type, ...} in S.queue. When there is internet, the queue is uploaded
 * to your Google Drive's hidden app folder as ONE file (chg-<device>-<time>-<rand>.json) and the laptop's snapshot.json is downloaded.
 * The laptop merges the change files whenever it runs. Until the laptop's next snapshot confirms ("acked") a change, it stays in S.sent and
 * is drawn on top of the snapshot, so nothing you did ever disappears from the screen.
 *
 * DUPLICATED FROM THE LAPTOP APP (keep in step; listed in PROJECT.md "Couplings to keep in sync"):
 *   statusFor        = statusForValue (script.js) = status_for_value (app.py)   the colour rule
 *   net kcal / deficit maths in renderFood            = foodNetHtml / foodMaintenance (script.js), net_kcal_days (app.py)
 *   schedItems       = scItemsOn (script.js)                                      which schedule items fall on a date
 *   formatDuration   = formatDuration (script.js) = the `duration` filter (app.py)
 *   t12              = the 12-hour times of the Schedule page
 *   openNote wording = openNoteModal (script.js): "Three in a row — what happened?" / "No judgment, just a quick note so future-you has context."
 *   threeInARow      = check_recent_misses (app.py): the two days before this one are both red / yellow
 *
 * BUILD 27 (what changed): one date per page (Quick Log opens on yesterday, Food and Schedule on today); gestures on a Quick Log check
 * (tap = done / cleared at once, a quick second tap = missed, a long hold = note); the 3-misses-in-a-row prompt; saved-food type-ahead in the
 * Name field + "Save to my foods" (change type food_lib_add); Inter shipped in fonts/; quieter Google sign-in renewal; the screen is patched
 * in place (morph) so a tap redraws only what changed.
 */
(function () {
    "use strict";

    var VERSION = "b27.1";
    var KEY = "duck.phone.v1", SNAPKEY = "duck.phone.snap", TOK = "duck.phone.tok";
    var API = "https://www.googleapis.com/drive/v3", UP = "https://www.googleapis.com/upload/drive/v3";
    var SCOPE = "https://www.googleapis.com/auth/drive.appdata";
    var MEALS = ["breakfast", "lunch", "snack", "dinner"];
    var DEFAULT_GREEN = "#5f9d74";
    var CID = (window.DUCK_CONFIG && window.DUCK_CONFIG.CLIENT_ID) || "";
    var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var LIMITS = { ql: [-14, 0], food: [-14, 0], sc: [-7, 14] };   // how far back / forward each page can go (days)
    var HOLD_MS = 500, DOUBLE_MS = 300;                            // long hold = note; a second tap within this = missed
    var RENEW_AHEAD = 5 * 60000, AWAY_MS = 5 * 60000;              // renew the Google token this long before it runs out; away this long = a fresh "open"

    // ---------------------------------------------------------------- small helpers
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function p2(n) { return String(n).padStart(2, "0"); }
    function iso(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
    function today() { return iso(new Date()); }
    function addDays(s, n) { var d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); }
    function diffDays(a, b) { return Math.round((new Date(a + "T12:00:00") - new Date(b + "T12:00:00")) / 86400000); }
    function dow(s) { return (new Date(s + "T12:00:00").getDay() + 6) % 7; }   // Monday = 0, like the laptop
    function dayLabel(s) {
        var n = diffDays(s, today());
        var d = new Date(s + "T12:00:00");
        var base = WEEKDAYS[dow(s)] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
        return n === 0 ? "Today" : n === -1 ? "Yesterday" : n === 1 ? "Tomorrow" : base;
    }
    function dayFull(s) { var d = new Date(s + "T12:00:00"); return WEEKDAYS[dow(s)] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
    function num(n) { return String(Math.round(Number(n || 0) * 10) / 10); }
    function round1(n) { return Math.round(n * 10) / 10; }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function rand(n) { var s = ""; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); }
    function clock(ms) {
        if (!ms) return "never";
        var d = new Date(ms), t = new Date();
        var hm = p2(d.getHours()) + ":" + p2(d.getMinutes());
        return d.toDateString() === t.toDateString() ? hm : d.getDate() + " " + MONTHS[d.getMonth()] + " " + hm;
    }
    function t12(t) { var a = String(t).split(":"), h = +a[0], m = +a[1]; var ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return h + (m ? ":" + p2(m) : "") + ap; }

    // colour rule - SAME AS statusForValue (script.js) / status_for_value (app.py)
    function statusFor(trackingType, target, value, direction) {
        var goal = target || (trackingType === "steps" ? 10000 : 0);
        if (goal > 0) return (direction === "max" ? value <= goal : value >= goal) ? "green" : "red";
        return value > 0 ? "green" : "red";
    }
    // SAME AS formatDuration (script.js)
    function formatDuration(minutes) {
        minutes = Math.round(minutes);
        if (minutes < 60) return minutes + " min";
        var h = Math.floor(minutes / 60), m = minutes % 60;
        return m ? h + "h " + m + "m" : h + "h";
    }
    function parseDuration(s) {   // "90", "1:30", "1h30", "1h 30m", "1.5h", "45m" -> minutes, or NaN
        s = String(s || "").trim().toLowerCase().replace(/,/g, ".");
        if (!s) return NaN;
        var m = s.match(/^(\d+):(\d{1,2})$/);
        if (m) return +m[1] * 60 + +m[2];
        m = s.match(/^(\d+)\s*h\s*(\d+)$/);
        if (m) return +m[1] * 60 + +m[2];
        m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?$/);
        if (m && (m[1] || m[2])) return Math.round((+m[1] || 0) * 60 + (+m[2] || 0));
        if (/^\d+(\.\d+)?$/.test(s)) return Math.round(+s);
        return NaN;
    }

    // ---------------------------------------------------------------- state (kept in this browser's localStorage)
    var MEMORY_ONLY = false;
    function blank() {
        return { v: 1, device: "ph-" + rand(8), snap: null, snapModified: "", queue: [], sent: [], seq: 0, lastSync: 0, lastErr: "",
                 overridden: 0, needLogin: false, consented: false, silentFailedAt: 0 };
    }
    // Build 27: the snapshot (big) is stored under its own key and rewritten only when it changes; a tap rewrites just the small state.
    // A Build 26 phone kept it inside KEY: it is read from there once and moved.
    var snapInline = false, MC = null;
    function load() {
        try {
            var o = JSON.parse(localStorage.getItem(KEY));
            if (o && o.v === 1 && o.device) {
                var st = Object.assign(blank(), o);
                var raw = null;
                try { raw = localStorage.getItem(SNAPKEY); } catch (e) { /* ignore */ }
                if (raw) { try { st.snap = JSON.parse(raw); } catch (e) { /* damaged: keep the inline copy if there is one */ } }
                return st;
            }
        } catch (e) { /* unreadable: start empty */ }
        return blank();
    }
    function saveSnap() {
        try { localStorage.setItem(SNAPKEY, JSON.stringify(S.snap)); snapInline = false; } catch (e) { snapInline = true; }
    }
    function save() {
        MC = null;   // anything that changes the state also changes the view model
        try {
            var copy = snapInline ? S : Object.assign({}, S, { snap: null });
            localStorage.setItem(KEY, JSON.stringify(copy));
            MEMORY_ONLY = false;
        } catch (e) { MEMORY_ONLY = true; }
    }
    var S = load();
    try { if (S.snap && localStorage.getItem(SNAPKEY) == null) { saveSnap(); save(); } } catch (e) { /* ignore */ }   // moves a Build 26 inline snapshot to its own key
    // One date PER PAGE (Build 27): Quick Log = yesterday, Food and Schedule = today, at every open and at day rollover.
    var U = { tab: "ql", dates: { ql: addDays(today(), -1), food: today(), sc: today() }, dayStamp: today(), sheet: null, hiddenAt: 0 };   // screen state (not saved)
    function D() { return U.dates[U.tab]; }
    function resetDates() { U.dates = { ql: addDays(today(), -1), food: today(), sc: today() }; U.dayStamp = today(); }
    try { var tabSaved = sessionStorage.getItem("duck.tab"); if (tabSaved === "food" || tabSaved === "sc" || tabSaved === "ql") U.tab = tabSaved; } catch (e) { /* ignore */ }
    var syncing = false, syncTimer = 0, ctx = { interactive: false };

    // ---------------------------------------------------------------- the view model = snapshot + unmerged changes on top
    function model() {
        if (MC) return MC;
        var snap = S.snap;
        if (!snap) return null;
        var M = { snap: snap, habits: snap.habits || [], byId: {}, entries: clone(snap.entries || {}), food: clone((snap.food && snap.food.entries) || {}),
                  log: clone((snap.schedule && snap.schedule.log) || {}), pendFood: {}, pendCell: {}, lockedFood: {},
                  foods: ((snap.food && snap.food.foods) || []).slice() };   // foods = My foods + the ones saved from this phone that the laptop has not confirmed yet
        M.habits.forEach(function (h) { M.byId[h.id] = h; });
        var all = S.sent.map(function (c) { return { c: c, sent: true }; }).concat(S.queue.map(function (c) { return { c: c, sent: false }; }));
        all.sort(function (a, b) { return a.c.ts - b.c.ts || (a.c.id < b.c.id ? -1 : 1); });
        all.forEach(function (x) { applyChange(M, x.c, x.sent); });
        M.foods.sort(function (a, b) { return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1; });
        MC = M;
        return M;
    }
    function savedFood(M, name) {   // a saved food with this name (any capitals), or null
        var n = String(name || "").trim().toLowerCase();
        if (!n) return null;
        for (var i = 0; i < M.foods.length; i++) if (String(M.foods[i].name).trim().toLowerCase() === n) return M.foods[i];
        return null;
    }
    function findFood(M, id) {
        for (var d in M.food) { var a = M.food[d]; for (var i = 0; i < a.length; i++) if (a[i].id === id) return { date: d, list: a, i: i }; }
        return null;
    }
    function applyChange(M, c, sent) {
        if (c.type === "cell") {
            (M.entries[c.habit] = M.entries[c.habit] || {})[c.date] = [c.status, c.value == null ? null : c.value];
            M.pendCell[c.habit + ":" + c.date] = true;
        } else if (c.type === "food_add") {
            (M.food[c.date] = M.food[c.date] || []).push({ id: "p:" + c.id, meal: c.meal, name: c.name, qty: c.qty, kcal: round1(c.kcal * c.qty), protein: round1(c.protein * c.qty),
                unit_kcal: c.kcal, unit_protein: c.protein, food_id: c.food_id == null ? null : c.food_id, pending: true });
            if (sent) M.lockedFood["p:" + c.id] = true;
        } else if (c.type === "food_edit") {
            var f = findFood(M, c.entry);
            if (f) { M.food[f.date][f.i] = Object.assign({}, f.list[f.i], { meal: c.meal, name: c.name, qty: c.qty, kcal: round1(c.kcal * c.qty), protein: round1(c.protein * c.qty),
                unit_kcal: c.kcal, unit_protein: c.protein, food_id: c.food_id == null ? null : c.food_id, pending: true }); }
        } else if (c.type === "food_del") {
            var g = findFood(M, c.entry);
            if (g) g.list.splice(g.i, 1);
        } else if (c.type === "tick") {
            var day = (M.log[c.date] = M.log[c.date] || {});
            if (c.state) day[c.key] = c.state; else delete day[c.key];
        } else if (c.type === "food_lib_add") {   // shows in the suggestions at once; the laptop skips it as a duplicate if the name is already there
            if (!savedFood(M, c.name)) M.foods.push({ id: "p:" + c.id, name: c.name, kcal: c.kcal, protein: c.protein, pending: true });
        }
    }
    function foodSum(M, date) {
        var k = 0, p = 0, n = 0;
        (M.food[date] || []).forEach(function (e) { k += e.kcal; p += e.protein; n++; });
        return { kcal: round1(k), protein: round1(p), n: n };
    }
    function cellOf(M, h, date) {   // [status, value] of a habit on a day, as the laptop would show it
        if (h.food_metric) {
            var s = foodSum(M, date);
            if (!s.n) return ["grey", null];
            var v = Math.floor(s[h.food_metric === "kcal" ? "kcal" : "protein"] + 0.5);   // int(v + 0.5) like recompute_food_habits
            return [statusFor("number", h.target, v, h.direction), v];
        }
        var e = (M.entries[h.id] || {})[date];
        return e ? [e[0], e[1]] : ["grey", null];
    }

    // ---------------------------------------------------------------- queue
    function enqueue(ch) {
        ch.id = S.device + "-" + Date.now() + "-" + (++S.seq);
        ch.ts = Date.now();
        var q = S.queue, entry = ch.entry;
        if (ch.type === "cell") q = q.filter(function (x) { return !(x.type === "cell" && x.habit === ch.habit && x.date === ch.date); });
        if (ch.type === "tick") q = q.filter(function (x) { return !(x.type === "tick" && x.key === ch.key && x.date === ch.date); });
        if (ch.type === "food_lib_add") q = q.filter(function (x) { return !(x.type === "food_lib_add" && String(x.name).toLowerCase() === String(ch.name).toLowerCase()); });
        if (ch.type === "food_edit" || ch.type === "food_del") {
            if (typeof entry === "string" && entry.indexOf("p:") === 0) {   // a food entry still waiting in the queue: change that record itself
                var addId = entry.slice(2), add = null;
                for (var i = 0; i < q.length; i++) if (q[i].id === addId && q[i].type === "food_add") add = q[i];
                if (!add) return false;   // already sent: it can be changed after the laptop has confirmed it
                if (ch.type === "food_del") q = q.filter(function (x) { return x !== add; });
                else { add.meal = ch.meal; add.name = ch.name; add.qty = ch.qty; add.kcal = ch.kcal; add.protein = ch.protein; add.food_id = ch.food_id; }
                S.queue = q; save(); scheduleSync(2500);
                return true;
            }
            q = q.filter(function (x) { return !((x.type === "food_edit" || x.type === "food_del") && x.entry === entry); });
        }
        q.push(ch);
        S.queue = q;
        save();
        scheduleSync(2500);
        return true;
    }

    // ---------------------------------------------------------------- rendering
    var TITLES = { ql: "Quick log", food: "Food", sc: "Schedule" };
    // The screen is PATCHED, not rebuilt: the new html is compared with what is on screen and only what differs is touched, so a tap changes
    // one cell (its colour fades in ~120 ms) instead of redrawing the page. Elements carry data-k so a row is never reused for another habit.
    function morph(dst, html) {
        var tmp = document.createElement("div");
        tmp.innerHTML = html;
        morphKids(dst, tmp);
    }
    function morphKids(a, b) {
        var ac = a.childNodes, bc = b.childNodes, i;
        for (i = 0; i < bc.length; i++) {
            var x = ac[i], y = bc[i];
            if (!x) { a.appendChild(y.cloneNode(true)); continue; }
            if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName || (x.nodeType === 1 && x.getAttribute("data-k") !== y.getAttribute("data-k"))) { a.replaceChild(y.cloneNode(true), x); continue; }
            if (x.nodeType === 3) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
            if (x.nodeType !== 1) continue;
            var j, at;
            for (j = 0; j < y.attributes.length; j++) { at = y.attributes[j]; if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value); }
            for (j = x.attributes.length - 1; j >= 0; j--) { at = x.attributes[j]; if (!y.hasAttribute(at.name)) x.removeAttribute(at.name); }
            morphKids(x, y);
        }
        while (a.childNodes.length > bc.length) a.removeChild(a.lastChild);
    }
    var fadeT = 0;
    function fadeIn() {   // the page / day fade (~300 ms): only when the page or the day changed, never for a tap
        var v = $("view");
        clearTimeout(fadeT);
        v.classList.remove("enter");
        void v.offsetWidth;
        v.classList.add("enter");
        fadeT = setTimeout(function () { v.classList.remove("enter"); }, 340);
    }
    function daybarHtml() {
        var date = D(), lim = LIMITS[U.tab], n = diffDays(date, today());
        var d = new Date(date + "T12:00:00");
        var prev = '<button type="button" class="d-btn" data-act="day" data-n="-1"' + (n <= lim[0] ? " disabled" : "") + ' aria-label="Previous day">‹</button>';
        var next = '<button type="button" class="d-btn" data-act="day" data-n="1"' + (n >= lim[1] ? " disabled" : "") + ' aria-label="Next day">›</button>';
        if (U.tab === "ql") {   // Yesterday | Today toggle + arrows (back 14 days, never forward past today)
            return prev + '<div class="d-label"><b>' + esc(WEEKDAYS[dow(date)] + " " + d.getDate() + " " + MONTHS[d.getMonth()]) + "</b></div>" +
                '<div class="seg" role="group" aria-label="Day"><button type="button" data-act="ql-set" data-d="-1" class="' + (n === -1 ? "on" : "") + '">Yesterday</button>' +
                '<button type="button" data-act="ql-set" data-d="0" class="' + (n === 0 ? "on" : "") + '">Today</button></div>' + next;
        }
        return prev + '<div class="d-label"><b>' + esc(dayLabel(date)) + "</b>" + (n === 0 ? " · " + esc(dayFull(date)) : "") + "</div>" +
            (n !== 0 ? '<button type="button" class="d-today" data-act="day-today">Today</button>' : "") + next;
    }
    function render() {
        var y = window.scrollY, M = model();
        if (M && !U.hadModel) { U.hadModel = true; U.enter = true; }
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === U.tab); });
        $("title").textContent = TITLES[U.tab];
        $("eyebrow").textContent = M && M.snap.username ? "Hi, " + M.snap.username : "DuckGoDo";
        $("fab").hidden = !(U.tab === "food" && M);
        morph($("daybar"), daybarHtml());
        var html;
        if (!M) html = emptyHtml();
        else if (U.tab === "ql") html = renderQL(M);
        else if (U.tab === "food") html = renderFood(M);
        else html = renderSched(M);
        if (U.enter) { $("view").innerHTML = html; fadeIn(); } else morph($("view"), html);
        U.enter = false;
        paintChip();
        window.scrollTo(0, y);
    }
    function emptyHtml() {
        return '<div class="card"><div class="empty"><b>No data from the laptop yet.</b><br>' +
            (CID && CID.indexOf("PASTE_") !== 0 ? "Make sure the laptop app has run its sync at least once, then tap the sync button at the top right of this page." :
                "This page is not connected yet. Open <b>config.js</b> and paste your Google Client ID (see SETUP_PHONE_SYNC.md).") + "</div></div>";
    }

    function valText(h, val, st) {
        if (h.routine) return "";
        if (h.tracking_type === "check") return "";
        var goal = h.target ? " / " + (h.direction === "max" ? "≤ " : "") + (h.tracking_type === "time" ? formatDuration(h.target) : num(h.target)) : "";
        if (val == null) return h.target ? (h.direction === "max" ? "≤ " : "/ ") + (h.tracking_type === "time" ? formatDuration(h.target) : num(h.target)) : "";
        var unit = h.food_metric ? (h.food_metric === "kcal" ? "kcal" : "g") : (h.tracking_type === "time" ? "" : h.unit || "");
        var v = h.tracking_type === "time" ? formatDuration(val) : num(val);
        return esc(v + goal + (unit ? " " + unit : ""));
    }
    function rowHtml(M, h, date) {
        var c = cellOf(M, h, date), st = c[0];
        var isCheck = h.tracking_type === "check";
        var pend = M.pendCell[h.id + ":" + date];
        var color = h.color ? ' style="--done:' + esc(h.color) + '"' : "";
        var note = h.routine ? '<span class="note">routine</span>' : h.food_metric ? '<span class="note">food log</span>' : "";
        return '<div class="row' + (pend ? " pend" : "") + '" data-k="h' + h.id + '"' + color + '><button type="button" class="name" data-act="habit" data-h="' + h.id + '">' + esc(h.name) + "</button>" +
            note + '<span class="val">' + valText(h, c[1], st) + "</span>" +
            '<button type="button" class="cell ' + (st === "grey" ? "" : st) + (h.derived ? " locked" : "") + '" data-act="cell" data-h="' + h.id + '" aria-label="' + esc(h.name) + (isCheck ? "" : " value") + '"></button></div>';
    }
    function renderQL(M) {
        var date = D(), hs = M.habits.filter(function (h) { return !h.ql_hidden; });
        var nn = hs.filter(function (h) { return h.list_type === "nonneg"; }), wip = hs.filter(function (h) { return h.list_type === "wip"; });
        var done = 0;
        nn.forEach(function (h) { if (cellOf(M, h, date)[0] === "green") done++; });
        var pct = nn.length ? Math.round(100 * done / nn.length) : 0;
        var html = '<div class="progress' + (nn.length && done === nn.length ? " complete" : "") + '" aria-label="Progress" data-k="p"><span style="width:' + pct + '%"></span></div>';
        if (!hs.length) return html + '<div class="card"><div class="empty">No habits yet. Add them on the laptop.</div></div>';
        html += '<div class="card">';
        if (nn.length) html += '<div class="section-label">Non-negotiables</div>' + nn.map(function (h) { return rowHtml(M, h, date); }).join("");
        if (wip.length) html += '<div class="section-label">Work in progress</div>' + wip.map(function (h) { return rowHtml(M, h, date); }).join("");
        return html + "</div>";
    }

    function goalState(g, v, n) {   // tint for a Calories / Protein card, same rule as the habit
        if (!g || !g.target || !n) return "";
        return statusFor("number", g.target, Math.round(v), g.direction || "min") === "green" ? " ok" : " bad";
    }
    function renderFood(M) {
        var date = D(), s = foodSum(M, date), goals = (M.snap.food && M.snap.food.goals) || {};
        var gk = goals.kcal, gp = goals.protein;
        function card(name, unit, v, g) {
            var goal = g && g.target ? (g.direction === "max" ? "at most " : "at least ") + num(g.target) : "no goal";
            return '<div class="metric' + goalState(g, v, s.n) + '"><div class="m-top"><span>' + name + "</span></div>" +
                '<div class="m-val">' + (s.n ? num(v) : "–") + "<span>" + unit + '</span></div><div class="m-sub">' + goal + "</div></div>";
        }
        var html = '<div class="metrics">' + card("Calories", "kcal", s.kcal, gk) + card("Protein", "g", s.protein, gp);
        var burn = M.snap.burn;
        if (burn) {   // SAME MATHS AS foodNetHtml / foodMaintenance (script.js): deficit = maintenance (the Calories goal) - (eaten - burned)
            var be = (M.entries[burn.habit_id] || {})[date];
            var burned = be && be[1] != null ? Math.round(be[1]) : 0;
            var eaten = Math.round(s.kcal), net = eaten - burned, maint = gk && gk.target ? gk.target : 0, dfc = maint - net;
            var st = !s.n ? "" : dfc >= 0 ? " ok" : " bad";
            var tag = !s.n ? "" : dfc > 0 ? "deficit" : dfc < 0 ? "over" : "at goal";
            html += '<div class="metric wide' + st + '"><div class="m-top"><span>Net kcal</span><span>' + tag + "</span></div>" +
                '<div class="m-val">' + (s.n ? Math.abs(dfc).toLocaleString("en-US") : "–") + "<span>" + (!s.n ? "kcal" : dfc >= 0 ? "kcal deficit" : "kcal over") + "</span></div>" +
                '<div class="m-sub">' + (s.n ? eaten.toLocaleString("en-US") : "0") + " eaten − " + burned.toLocaleString("en-US") + " burned = " + (s.n ? net.toLocaleString("en-US") : "0") + " net · " +
                (maint ? maint.toLocaleString("en-US") + " goal" : "no Calories goal") + " · " + esc(burn.name) + (be && be[1] != null ? "" : ", nothing logged") + "</div></div>";
        }
        html += "</div>";
        var list = M.food[date] || [];
        html += '<div class="card">';
        MEALS.forEach(function (meal) {
            var es = list.filter(function (e) { return e.meal === meal; });
            html += '<div class="meal-head"><span class="section-label">' + meal + '</span><button type="button" data-act="food-add" data-meal="' + meal + '">+ Add</button></div>';
            html += es.map(function (e) {
                var locked = M.lockedFood[e.id];
                return '<button type="button" class="frow' + (e.pending ? " pend" : "") + '" data-k="f' + esc(e.id) + '" data-act="food-edit" data-id="' + esc(e.id) + '"' + (locked ? ' data-locked="1"' : "") + '><span class="f-name">' + esc(e.name) +
                    (e.qty && e.qty !== 1 ? ' <span class="f-sub">× ' + num(e.qty) + "</span>" : "") + '</span><span class="f-nums">' + num(e.kcal) + " kcal<small>" + num(e.protein) + " g protein</small></span></button>";
            }).join("");
        });
        if (!list.length) html += '<div class="empty">Nothing logged for ' + esc(dayLabel(date).toLowerCase()) + ". Tap + Add food.</div>";
        return html + "</div>";
    }

    // SAME AS scItemsOn (script.js)
    function schedItems(M, date) {
        var sc = M.snap.schedule || { slots: [], events: [] }, wd = dow(date), log = M.log[date] || {}, out = [];
        (sc.slots || []).forEach(function (s) { if (s.days.charAt(wd) === "1" && s.from <= date && (!s.to || s.to >= date)) out.push(Object.assign({}, s, { ev: false, state: log[s.key] || "" })); });
        (sc.events || []).forEach(function (e) { if (e.date === date) out.push(Object.assign({}, e, { ev: true, state: log[e.key] || "" })); });
        out.sort(function (a, b) { return a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.name.localeCompare(b.name); });
        return out;
    }
    function renderSched(M) {
        var date = D(), items = schedItems(M, date);
        if (!items.length) return '<div class="card"><div class="empty">Nothing scheduled for ' + esc(dayLabel(date).toLowerCase()) + ".</div></div>";
        var done = items.filter(function (i) { return i.state === "done"; }).length;
        return '<div class="card"><div class="section-label">' + done + " of " + items.length + " done</div>" + items.map(function (it) {
            return '<div class="srow ' + (it.state === "done" ? "done" : it.state === "skip" ? "skipped" : "") + '" data-k="s' + esc(it.key) + '" style="--c:' + esc(it.color || DEFAULT_GREEN) + '">' +
                '<span class="bar ' + (it.list_type === "nonneg" ? "" : "wip") + '"></span>' +
                '<button type="button" class="s-main" data-act="tick" data-key="' + esc(it.key) + '"><div class="s-name">' + esc(it.name) + '</div><div class="s-time">' + t12(it.start) + "–" + t12(it.end) + (it.ev ? " · one day" : "") + (it.state === "skip" ? " · skipped" : "") + "</div></button>" +
                '<button type="button" class="s-skip" data-act="skip" data-key="' + esc(it.key) + '">' + (it.state === "skip" ? "Unskip" : "Skip") + "</button>" +
                '<button type="button" class="cell ' + (it.state === "done" ? "green" : "") + (it.state === "skip" ? " sched skip" : "") + '" data-act="tick" data-key="' + esc(it.key) + '" aria-label="Tick ' + esc(it.name) + '"></button></div>';
        }).join("") + "</div>";
    }

    // ---------------------------------------------------------------- toast + sheet
    var toastT = 0;
    function toast(msg, ms) {
        var t = $("toast");
        t.textContent = msg;
        t.classList.add("show");
        clearTimeout(toastT);
        toastT = setTimeout(function () { t.classList.remove("show"); }, ms || 2600);
    }
    function openSheet(html) {
        var sh = $("sheet");
        sh.innerHTML = html;
        sh.classList.add("open");
        sh.setAttribute("aria-hidden", "false");
        $("backdrop").classList.add("open");
        U.sheet = true;
        U.sheetAt = Date.now();
    }
    function closeSheet() {
        $("sheet").classList.remove("open");
        $("sheet").setAttribute("aria-hidden", "true");
        $("backdrop").classList.remove("open");
        U.sheet = null;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        checkRollover();   // a day change that happened while the sheet was open
    }

    // ---- habit sheet (value, done / missed / clear, note)
    function openHabit(id) {
        var M = model(), h = M && M.byId[id];
        if (!h) return;
        var date = D(), c = cellOf(M, h, date);
        if (h.derived) {
            toast(h.routine ? "This one follows a routine on the laptop." : "This one follows the food log.");
            if (h.food_metric) { U.tab = "food"; U.enter = true; render(); }
            return;
        }
        var body = '<h2>' + esc(h.name) + '</h2><div class="sub">' + esc(dayFull(date)) + (h.target ? " · goal " + (h.direction === "max" ? "at most " : "at least ") + (h.tracking_type === "time" ? formatDuration(h.target) : num(h.target) + (h.unit ? " " + h.unit : "")) : "") + "</div>";
        if (h.tracking_type === "check") {
            body += '<div class="btns"><button type="button" class="btn green" data-act="set-status" data-h="' + id + '" data-s="green">Done</button>' +
                '<button type="button" class="btn red" data-act="set-status" data-h="' + id + '" data-s="' + (h.list_type === "nonneg" ? "red" : "yellow") + '">Missed</button>' +
                '<button type="button" class="btn" data-act="set-status" data-h="' + id + '" data-s="grey">Clear</button></div>';
        } else {
            var isTime = h.tracking_type === "time";
            var cur = c[1] == null ? "" : isTime ? formatDuration(c[1]) : String(c[1]);
            body += '<label for="hv">' + (isTime ? "Time (for example 45, 1h 20m or 1:20)" : "Value" + (h.unit ? " (" + esc(h.unit) + ")" : "")) + "</label>" +
                '<input id="hv" ' + (isTime ? 'type="text" inputmode="text"' : 'type="number" inputmode="decimal" step="any" min="0"') + ' value="' + esc(cur) + '" autocomplete="off">' +
                (h.sleep ? '<div class="sub" style="margin-top:6px">Bed and wake times are logged on the laptop; here you enter the time slept.</div>' : "") +
                '<div class="btns"><button type="button" class="btn primary" data-act="save-value" data-h="' + id + '">Save</button>' +
                '<button type="button" class="btn" data-act="clear-value" data-h="' + id + '"' + (c[1] == null ? " disabled" : "") + ">Clear</button></div>";
        }
        body += '<label for="nt">Add a note to this day</label><input id="nt" type="text" placeholder="Title (optional)" maxlength="120" autocomplete="off" style="margin-bottom:8px">' +
            '<textarea id="nc" placeholder="Note" maxlength="2000"></textarea>' +
            '<div class="btns"><button type="button" class="btn" data-act="save-note" data-h="' + id + '" data-date="' + date + '">Add note</button><button type="button" class="btn" data-act="close">Close</button></div>';
        openSheet(body);
        var hv = $("hv");
        if (hv) {
            hv.addEventListener("input", function () { previewValue(h); });
            previewValue(h);
            setTimeout(function () { hv.focus(); hv.select && hv.select(); }, 260);
        }
    }
    // ---- note sheet: a long hold on a Quick Log cell, and the "Three in a row" prompt (same words as the laptop's openNoteModal)
    function openNote(h, date, skip) {
        openSheet('<div class="eyebrow-s">' + esc(h.name) + " · " + esc(dayLabel(date)) + "</div>" +
            "<h2>" + (skip ? "Three in a row — what happened?" : "Add a note") + "</h2>" +
            '<div class="sub">' + (skip ? "No judgment, just a quick note so future-you has context." : "A few words for your future self is enough.") + "</div>" +
            '<input id="nt" type="text" placeholder="Title (optional)" maxlength="120" autocomplete="off" aria-label="Note title" style="margin-bottom:8px">' +
            '<textarea id="nc" placeholder="Note" maxlength="2000" aria-label="Note"></textarea>' +
            '<div class="btns"><button type="button" class="btn primary" data-act="save-note" data-h="' + h.id + '" data-date="' + date + '"' + (skip ? ' data-skip="1"' : "") + ">Save note</button>" +
            '<button type="button" class="btn" data-act="close">' + (skip ? "Not now" : "Close") + "</button></div>");
        setTimeout(function () { var el = $("nc"); if (el && U.sheet) el.focus(); }, 260);
    }
    function threeInARow(M, h, date) {   // SAME IDEA AS check_recent_misses (app.py): the two days before this one were also misses (red or yellow)
        return [1, 2].every(function (n) { var st = cellOf(M, h, addDays(date, -n))[0]; return st === "red" || st === "yellow"; });
    }
    function readValue(h) {
        var raw = $("hv").value;
        if (!String(raw).trim()) return NaN;
        var v = h.tracking_type === "time" ? parseDuration(raw) : parseFloat(raw);
        return v >= 0 ? v : NaN;
    }
    function previewValue(h) {   // live colour, the same preview as the laptop's value popup
        var el = $("hv"), v = readValue(h);
        el.classList.remove("good", "badv");
        if (!isNaN(v)) el.classList.add(statusFor(h.tracking_type, h.target, v, h.direction) === "green" ? "good" : "badv");
    }
    function missedStatus(h) { return h.list_type === "nonneg" ? "red" : "yellow"; }
    function setCell(h, status, value, date) {
        date = date || D();
        if (diffDays(date, today()) > 0) { toast("That day has not come yet."); return; }
        enqueue({ type: "cell", habit: h.id, date: date, status: status, value: value });
        render();
        // a miss that makes three in a row asks what happened (the answer is saved as a skip-reason note, like on the laptop)
        if ((status === "red" || status === "yellow") && !h.derived && threeInARow(model(), h, date)) openNote(h, date, true);
    }

    // ---- food sheet (add / edit)
    function openFood(opts) {
        var M = model();
        if (!M) return;
        var e = opts.entry || null, date = D();
        var meal = e ? e.meal : opts.meal || guessMeal();
        var body = "<h2>" + (e ? "Edit food" : "Add food") + '</h2><div class="sub">' + esc(dayFull(date)) + "</div>";
        body += '<label for="fn">Name</label><div class="ta"><input id="fn" type="text" maxlength="80" value="' + esc(e ? e.name : "") + '" autocomplete="off" autocapitalize="sentences" role="combobox" aria-expanded="false" aria-controls="fta"><div class="ta-list" id="fta" role="listbox" hidden></div></div>' +
            '<div class="grid3"><div><label for="fq">Quantity</label><input id="fq" type="number" inputmode="decimal" step="any" min="0" value="' + (e ? e.qty : 1) + '"></div>' +
            '<div><label for="fk">kcal each</label><input id="fk" type="number" inputmode="decimal" step="any" min="0" value="' + (e ? e.unit_kcal : "") + '"></div>' +
            '<div><label for="fp">Protein g each</label><input id="fp" type="number" inputmode="decimal" step="any" min="0" value="' + (e ? e.unit_protein : "") + '"></div></div>' +
            '<label for="fm">Meal</label><select id="fm">' + MEALS.map(function (m) { return '<option value="' + m + '"' + (m === meal ? " selected" : "") + ">" + m.charAt(0).toUpperCase() + m.slice(1) + "</option>"; }).join("") + "</select>" +
            (e ? "" : '<label class="chk" id="fsave-wrap" hidden><input type="checkbox" id="fsave" checked><span>Save to my foods</span></label>') +
            '<div class="total" id="ftotal"></div>' +
            '<div class="btns"><button type="button" class="btn primary" data-act="food-save"' + (e ? ' data-id="' + esc(e.id) + '"' : "") + ">Save</button>" +
            (e ? '<button type="button" class="btn danger" data-act="food-del" data-id="' + esc(e.id) + '">Delete</button>' : "") +
            '<button type="button" class="btn" data-act="close">Cancel</button></div>';
        openSheet(body);
        U.foodId = e && e.food_id != null ? e.food_id : null;
        U.taList = [];
        var upd = function () {
            var q = parseFloat($("fq").value) || 0, k = parseFloat($("fk").value) || 0, p = parseFloat($("fp").value) || 0;
            $("ftotal").textContent = "Total: " + num(k * q) + " kcal · " + num(p * q) + " g protein";
        };
        ["fq", "fk", "fp"].forEach(function (id) { $(id).addEventListener("input", upd); $(id).addEventListener("focus", hideTypeahead); });
        $("fm").addEventListener("focus", hideTypeahead);
        // type-ahead: saved foods (+ the ones just saved from this phone) matching what is typed; a tap fills name, kcal and protein per unit
        $("fn").addEventListener("input", function () {
            U.foodId = null;   // typing after a pick makes it a different food
            var M2 = model(), term = this.value.trim().toLowerCase();
            var exact = savedFood(M2, term);
            if (exact && !$("fk").value && !$("fp").value) { fillFood(exact); upd(); }   // the exact name with the numbers still empty fills them, like the laptop
            else paintTypeahead(M2, term);
            saveBox();
        });
        $("fn").addEventListener("focus", function () { paintTypeahead(model(), $("fn").value.trim().toLowerCase()); });
        saveBox();
        upd();
        if (!e) setTimeout(function () { var el = $("fn"); if (el && U.sheet) el.focus(); }, 260);
    }
    function foodMatches(M, term) {
        if (!term) return [];
        var hit = M.foods.filter(function (f) { return String(f.name).toLowerCase().indexOf(term) >= 0; });
        hit.sort(function (a, b) {
            var pa = String(a.name).toLowerCase().indexOf(term) === 0 ? 0 : 1, pb = String(b.name).toLowerCase().indexOf(term) === 0 ? 0 : 1;
            return pa - pb || (String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1);
        });
        return hit.slice(0, 6);
    }
    function paintTypeahead(M, term) {
        var box = $("fta");
        if (!box) return;
        var list = foodMatches(M, term).filter(function (f) { return String(f.name).trim().toLowerCase() !== term; });   // an exact, finished name needs no suggestion
        U.taList = list;
        box.innerHTML = list.map(function (f, i) {
            return '<button type="button" role="option" data-act="food-pick" data-i="' + i + '"><span class="t-name">' + esc(f.name) + (f.pending ? " •" : "") + '</span><span class="t-nums">' + num(f.kcal) + " kcal · " + num(f.protein) + " g</span></button>";
        }).join("");
        box.hidden = !list.length;
        $("fn").setAttribute("aria-expanded", list.length ? "true" : "false");
    }
    function hideTypeahead() { var box = $("fta"); if (box) { box.hidden = true; $("fn").setAttribute("aria-expanded", "false"); } }
    function fillFood(f) {
        $("fn").value = f.name; $("fk").value = f.kcal; $("fp").value = f.protein;
        U.foodId = typeof f.id === "number" ? f.id : null;   // a food saved from this phone has no laptop id yet
        if (!(+$("fq").value > 0)) $("fq").value = 1;
        hideTypeahead();
    }
    function saveBox() {   // "Save to my foods": only for a name that is not a saved food yet (add only)
        var w = $("fsave-wrap");
        if (!w) return;
        var name = $("fn").value.trim();
        w.hidden = !name || !!savedFood(model(), name) || U.foodId != null;
    }
    function guessMeal() { var h = new Date().getHours(); return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 18 ? "snack" : "dinner"; }
    function saveFood(editId) {
        var name = $("fn").value.trim(), qty = parseFloat($("fq").value), k = parseFloat($("fk").value) || 0, p = parseFloat($("fp").value) || 0;
        if (!name) { toast("Give it a name."); return; }
        if (!(qty > 0)) { toast("Quantity has to be more than zero."); return; }
        var f = { meal: $("fm").value, name: name, qty: qty, kcal: k, protein: p, food_id: U.foodId == null ? null : U.foodId };
        if (editId) {
            var id = /^\d+$/.test(editId) ? Number(editId) : editId;
            if (!enqueue(Object.assign({ type: "food_edit", entry: id }, f))) { toast("This entry is still being sent. Try again in a moment."); return; }
        } else {
            if (diffDays(D(), today()) > 0) { toast("That day has not come yet."); return; }
            var w = $("fsave-wrap");
            if (w && !w.hidden && $("fsave").checked) enqueue({ type: "food_lib_add", name: name, kcal: k, protein: p });   // per ONE unit, like My foods
            enqueue(Object.assign({ type: "food_add", date: D() }, f));
        }
        closeSheet();
        render();
        toast(editId ? "Saved." : "Added. It will sync when there is internet.");
    }

    // ---- sync sheet
    function openSync() {
        var waiting = S.queue.length, sent = S.sent.length;
        var snap = S.snap;
        var body = "<h2>Sync</h2><div class=\"sub\">Your phone and laptop meet through your own Google Drive.</div>";
        if (!configured()) {
            body += '<div class="warn"><b>Not connected yet.</b> Open <b>config.js</b> in the phone folder and paste your Google Client ID, publish again, then reopen this page. See SETUP_PHONE_SYNC.md.</div>';
        }
        body += '<div class="kv"><span>Laptop data from</span><b>' + esc(snap && snap.generated_text ? snap.generated_text : "nothing yet") + "</b></div>" +
            '<div class="kv"><span>Last sync here</span><b>' + esc(clock(S.lastSync)) + "</b></div>" +
            '<div class="kv"><span>Waiting to be sent</span><b>' + waiting + "</b></div>" +
            '<div class="kv"><span>Sent, laptop has not merged yet</span><b>' + sent + "</b></div>" +
            '<div class="kv"><span>This phone</span><b>' + esc(S.device) + "</b></div>" +
            '<div class="kv"><span>Version</span><b>' + VERSION + "</b></div>";
        if (S.lastErr) body += '<div class="warn">' + esc(S.lastErr) + "</div>";
        if (S.overridden) body += '<div class="warn">' + S.overridden + " of your changes " + (S.overridden === 1 ? "was" : "were") + " older than an edit made on the laptop, so the laptop's version was kept. The laptop's sync log lists them.</div>";
        if (MEMORY_ONLY) body += '<div class="warn">This browser is not letting the page save anything. Changes will be lost when you close it.</div>';
        if (!navigator.onLine) body += '<div class="warn">You are offline. Everything you log is kept here and sent when the signal is back.</div>';
        body += '<div class="btns"><button type="button" class="btn primary" data-act="sync-go"' + (configured() ? "" : " disabled") + ">" + (S.needLogin ? "Sign in to Google" : "Sync now") + '</button><button type="button" class="btn" data-act="close">Close</button></div>';
        if (S.overridden) body += '<div class="btns"><button type="button" class="btn" data-act="clear-notice">Got it</button></div>';
        openSheet(body);
    }

    // ---------------------------------------------------------------- sync chip
    function configured() { return !!CID && CID.indexOf("PASTE_") !== 0; }
    function paintChip() {
        var c = $("chip"), t = $("chip-text"), q = S.queue.length, s = S.sent.length, cls = "", text;
        if (!configured()) { cls = "off"; text = "Not connected"; }
        else if (syncing) { cls = "busy"; text = "Syncing…"; }
        else if (!navigator.onLine) { cls = "off"; text = q || s ? "Offline · " + (q + s) + " waiting" : "Offline"; }
        else if (S.needLogin) { cls = "bad"; text = "Tap to sign in"; }
        else if (S.lastErr) { cls = "bad"; text = "Sync failed"; }
        else if (q) { cls = "wait"; text = q + " to send"; }
        else if (s) { cls = "wait"; text = "Sent · laptop will merge"; }
        else if (S.lastSync) text = "Synced " + clock(S.lastSync);
        else { cls = "off"; text = "Not synced yet"; }
        c.className = "chip " + cls;
        t.textContent = text;
    }

    // ---------------------------------------------------------------- Google sign-in (token model) + Drive
    function NeedLogin(why) { this.name = "NeedLogin"; this.why = why; this.message = "Sign in to Google (" + why + ")"; }
    NeedLogin.prototype = Object.create(Error.prototype);
    function tokenValid() {
        try { var t = JSON.parse(localStorage.getItem(TOK)); if (t && t.token && t.exp > Date.now() + 60000) return t.token; } catch (e) { /* none */ }
        return null;
    }
    function tokenExpiry() {
        try { var t = JSON.parse(localStorage.getItem(TOK)); if (t && t.token) return t.exp || 0; } catch (e) { /* none */ }
        return 0;
    }
    function dropToken() { try { localStorage.removeItem(TOK); } catch (e) { /* ignore */ } }
    function gisReady() { return !!(window.google && google.accounts && google.accounts.oauth2); }
    function loadGis() {
        return new Promise(function (res, rej) {
            if (gisReady()) return res();
            var s = document.createElement("script");
            s.src = "https://accounts.google.com/gsi/client";
            s.async = true;
            s.onload = function () { res(); };
            s.onerror = function () { rej(new Error("Could not load Google sign-in (no internet?)")); };
            document.head.appendChild(s);
        });
    }
    function requestToken() {
        return loadGis().then(function () {
            return new Promise(function (resolve, reject) {
                var done = false, timer = setTimeout(function () { if (!done) { done = true; reject(new NeedLogin("timeout")); } }, 90000);
                var client = google.accounts.oauth2.initTokenClient({
                    client_id: CID, scope: SCOPE,
                    callback: function (r) {
                        if (done) return;
                        done = true; clearTimeout(timer);
                        if (r && r.access_token) {
                            try { localStorage.setItem(TOK, JSON.stringify({ token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 })); } catch (e) { /* ignore */ }
                            S.consented = true; S.needLogin = false; S.silentFailedAt = 0; save();
                            resolve(r.access_token);
                        } else reject(new NeedLogin((r && r.error) || "not allowed"));
                    },
                    error_callback: function (e) { if (done) return; done = true; clearTimeout(timer); reject(new NeedLogin((e && e.type) || "blocked")); }
                });
                client.requestAccessToken({ prompt: "" });
            });
        });
    }
    function ensureToken() {
        var t = tokenValid();
        if (t) return Promise.resolve(t);
        if (!ctx.interactive) {
            // from the background we only try if you signed in before, and not again for 10 minutes after a failure (a popup needs a tap)
            if (!S.consented || (S.silentFailedAt && Date.now() - S.silentFailedAt < 600000)) return Promise.reject(new NeedLogin("tap needed"));
        }
        return requestToken().catch(function (e) {
            if (e instanceof NeedLogin) { S.needLogin = true; S.silentFailedAt = Date.now(); save(); }
            throw e;
        });
    }
    // Build 27: the 1-hour token is renewed in the background, at open / resume and shortly before the hour is up while the page is visible, so
    // logging and syncing almost never meet a sign-in. Only when this quiet renewal fails does the chip say "Tap to sign in".
    var renewing = null;
    function renewQuietly(force) {
        if (renewing || !configured() || !S.consented || !navigator.onLine || document.hidden) return Promise.resolve();
        if (tokenExpiry() > Date.now() + RENEW_AHEAD) return Promise.resolve();   // plenty of time left
        if (!force && S.silentFailedAt && Date.now() - S.silentFailedAt < 600000) return Promise.resolve();   // the timer does not nag after a failure
        renewing = requestToken().then(function () {
            paintChip();
            if (S.queue.length) scheduleSync(300);
        }).catch(function (e) {
            if (e instanceof NeedLogin) { S.needLogin = true; S.silentFailedAt = Date.now(); save(); paintChip(); }
        }).then(function () { renewing = null; });
        return renewing;
    }
    function gfetch(url, init, again) {
        init = init || {};
        return ensureToken().then(function (tok) {
            init.headers = Object.assign({}, init.headers, { Authorization: "Bearer " + tok });
            return fetch(url, init);
        }).then(function (r) {
            if (r.status === 401 && !again) { dropToken(); return gfetch(url, init, true); }
            if (r.status === 401) { dropToken(); S.needLogin = true; save(); throw new NeedLogin("expired"); }
            if (r.status === 403) throw new Error("Google Drive said no (403). Is the Drive API switched on, and is this Google account added as a test user?");
            if (!r.ok) throw new Error("Google Drive error " + r.status);
            return r;
        });
    }
    function driveSnapshotMeta() {
        var q = encodeURIComponent("name = 'snapshot.json' and trashed = false");
        return gfetch(API + "/files?spaces=appDataFolder&pageSize=10&q=" + q + "&fields=files(id,name,modifiedTime)").then(function (r) { return r.json(); }).then(function (d) {
            var f = (d.files || []).filter(function (x) { return x.name === "snapshot.json"; }).sort(function (a, b) { return a.modifiedTime < b.modifiedTime ? 1 : -1; });
            return f[0] || null;
        });
    }
    function driveCreate(name, text) {
        var b = "duckgodo" + Date.now();
        var meta = JSON.stringify({ name: name, parents: ["appDataFolder"] });
        var body = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + b + "\r\nContent-Type: application/json\r\n\r\n" + text + "\r\n--" + b + "--";
        return gfetch(UP + "/files?uploadType=multipart", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body: body }).then(function (r) { return r.json(); });
    }
    function driveRead(id) { return gfetch(API + "/files/" + id + "?alt=media").then(function (r) { return r.text(); }); }

    function parseSnapshot(txt) {
        try {
            var s = JSON.parse(txt);
            if (s && s.v === 1 && Array.isArray(s.habits) && s.food && s.schedule) return s;
        } catch (e) { /* damaged: keep the last good one */ }
        return null;
    }
    function processAcks() {
        var acked = (S.snap && S.snap.acked && S.snap.acked[S.device]) || {};
        var cutoff = Date.now() - 25 * 86400000;
        S.sent = S.sent.filter(function (c) {
            var a = acked[c.id];
            if (a) { if (a === "old") S.overridden++; return false; }
            return c.ts > cutoff;
        });
    }
    function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(function () { syncNow(false); }, ms || 2500); }
    function syncNow(interactive) {
        if (syncing) return Promise.resolve();
        if (!configured()) { if (interactive) openSync(); return Promise.resolve(); }
        if (!navigator.onLine) { paintChip(); return Promise.resolve(); }
        if (!interactive && S.needLogin) return Promise.resolve();
        syncing = true; ctx.interactive = !!interactive; paintChip();
        var batch = null;
        return Promise.resolve().then(function () {
            return ensureToken();
        }).then(function () {
            if (!S.queue.length) return null;
            batch = S.queue.slice();
            var created = Date.now();
            return driveCreate("chg-" + S.device + "-" + created + "-" + rand(4) + ".json", JSON.stringify({ v: 1, device: S.device, created: created, changes: batch })).then(function () {
                S.queue = S.queue.filter(function (x) { return batch.indexOf(x) < 0; });   // anything logged during the upload stays queued
                S.sent = S.sent.concat(batch);
                save();
            });
        }).then(driveSnapshotMeta).then(function (meta) {
            if (!meta) return null;
            if (S.snap && meta.modifiedTime === S.snapModified) return null;
            return driveRead(meta.id).then(function (txt) {
                var snap = parseSnapshot(txt);
                if (!snap) { S.lastErr = "The laptop's snapshot could not be read. Showing the last good copy."; S.snapBad = true; return null; }
                S.snap = snap; S.snapModified = meta.modifiedTime;
                saveSnap();
                return null;
            });
        }).then(function () {
            if (S.snap) processAcks();
            S.lastSync = Date.now();
            if (!S.snapBad) S.lastErr = "";
            S.snapBad = false;
            S.needLogin = false;
            save();
        }).catch(function (e) {
            if (e instanceof NeedLogin) { S.needLogin = true; S.lastErr = ""; }
            else S.lastErr = (e && e.message) || "Sync failed.";
            save();
        }).then(function () {
            syncing = false; ctx.interactive = false;
            render();
            if (U.sheet && $("sheet").querySelector('[data-act="sync-go"]')) openSync();
        });
    }

    // ---------------------------------------------------------------- events
    // Quick Log check cell gestures: a TAP marks done / clears at once; a quick SECOND tap (within DOUBLE_MS) makes it missed; a long HOLD (HOLD_MS)
    // opens the note sheet for that habit and day. A value cell: tap opens the value sheet, hold = note.
    var G = { t: 0, fired: false, x: 0, y: 0, last: {} };
    function habitOfCell(cell) { return (S.snap && S.snap.habits || []).filter(function (x) { return x.id === +cell.dataset.h; })[0]; }
    document.addEventListener("pointerdown", function (ev) {
        var cell = ev.target.closest && ev.target.closest('.cell[data-act="cell"]');
        G.fired = false;
        clearTimeout(G.t);
        if (!cell) return;
        var h = habitOfCell(cell);
        if (!h || h.derived) return;
        G.x = ev.clientX; G.y = ev.clientY;
        G.t = setTimeout(function () {
            G.fired = true;
            if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* ignore */ } }
            openNote(h, D(), false);
        }, HOLD_MS);
    });
    document.addEventListener("pointermove", function (ev) { if (G.t && Math.abs(ev.clientX - G.x) + Math.abs(ev.clientY - G.y) > 12) { clearTimeout(G.t); G.t = 0; } });
    ["pointerup", "pointercancel", "pointerleave", "scroll"].forEach(function (n) { document.addEventListener(n, function () { clearTimeout(G.t); G.t = 0; }, true); });
    document.addEventListener("contextmenu", function (ev) { if (ev.target.closest && ev.target.closest(".cell")) ev.preventDefault(); });   // no Android long-press menu on a cell

    function setDate(n, fade) { U.dates[U.tab] = n; if (fade !== false) U.enter = true; render(); }
    function checkRollover() {   // a new day (or an app that was away a while) is a fresh "open": Quick Log back on yesterday, Food and Schedule on today
        if (U.sheet) return;
        if (U.dayStamp !== today()) { resetDates(); U.enter = true; render(); }
    }

    document.addEventListener("click", function (ev) {
        var tab = ev.target.closest && ev.target.closest("[data-tab]");
        if (tab) { U.tab = tab.dataset.tab; try { sessionStorage.setItem("duck.tab", U.tab); } catch (e) { /* ignore */ } closeSheet(); U.enter = true; render(); return; }
        if (ev.target.id === "backdrop") { if (Date.now() - (U.sheetAt || 0) > 450) closeSheet(); return; }
        var el = ev.target.closest && ev.target.closest("[data-act]");
        if (!el) return;
        var act = el.dataset.act, M;
        if (act === "cell" && G.fired) { G.fired = false; return; }   // the hold already opened the note sheet
        switch (act) {
            case "chip": if (S.needLogin && configured()) syncNow(true); else openSync(); break;
            case "day": setDate(addDays(D(), +el.dataset.n)); break;
            case "day-today": setDate(today()); break;
            case "ql-set": setDate(addDays(today(), +el.dataset.d)); break;
            case "habit": openHabit(+el.dataset.h); break;
            case "cell": {
                M = model(); var h = M && M.byId[+el.dataset.h];
                if (!h) break;
                if (h.derived) { openHabit(h.id); break; }
                if (h.tracking_type !== "check") { openHabit(h.id); break; }
                var date = D(), gk = h.id + ":" + date, now = Date.now();
                if (G.last[gk] && now - G.last[gk] < DOUBLE_MS) { G.last = {}; setCell(h, missedStatus(h), null, date); }   // quick second tap = missed
                else { G.last = {}; G.last[gk] = now; setCell(h, cellOf(M, h, date)[0] === "green" ? "grey" : "green", null, date); }   // tap = done / cleared at once
                break;
            }
            case "set-status": { M = model(); var hh = M.byId[+el.dataset.h]; closeSheet(); setCell(hh, el.dataset.s, null); break; }
            case "save-value": {
                M = model(); var hv = M.byId[+el.dataset.h], v = readValue(hv);
                if (isNaN(v)) { toast(hv.tracking_type === "time" ? "Enter a time, like 45 or 1h 20m." : "Enter a number."); break; }
                if (v > 10000000) { toast("That number is too big."); break; }
                closeSheet(); setCell(hv, statusFor(hv.tracking_type, hv.target, v, hv.direction), v);
                break;
            }
            case "clear-value": { M = model(); var hc = M.byId[+el.dataset.h]; closeSheet(); setCell(hc, "grey", null); break; }
            case "save-note": {
                var title = $("nt").value.trim(), content = $("nc").value.trim();
                if (!title && !content) { toast("Write something first."); break; }
                var nch = { type: "note", habit: +el.dataset.h, date: el.dataset.date || D(), title: title, content: content };
                if (el.dataset.skip) nch.skip_reason = true;   // the "Three in a row" answer is a skip reason (the laptop files it with is_skip_reason = 1)
                enqueue(nch);
                closeSheet(); toast("Note saved. It will sync when there is internet."); break;
            }
            case "food-add": openFood({ meal: el.dataset.meal }); break;
            case "food-edit": {
                M = model(); var id = /^\d+$/.test(el.dataset.id) ? Number(el.dataset.id) : el.dataset.id;
                var f = findFood(M, id);
                if (!f) break;
                if (el.dataset.locked) { toast("Still being sent. You can change it once the laptop has it."); break; }
                openFood({ entry: f.list[f.i] });
                break;
            }
            case "food-pick": { var pf = (U.taList || [])[+el.dataset.i]; if (!pf) break; fillFood(pf); $("fn").focus(); ["fq", "fk"].forEach(function (i) { $(i).dispatchEvent(new Event("input")); }); saveBox(); break; }
            case "food-save": saveFood(el.dataset.id || ""); break;
            case "food-del": {
                if (el.dataset.armed !== "1") { el.dataset.armed = "1"; el.textContent = "Tap again to delete"; break; }
                var did = /^\d+$/.test(el.dataset.id) ? Number(el.dataset.id) : el.dataset.id;
                if (!enqueue({ type: "food_del", entry: did })) toast("This entry is still being sent.");
                closeSheet(); render(); toast("Deleted."); break;
            }
            case "tick": case "skip": {
                M = model(); var key = el.dataset.key, date2 = D(), it = schedItems(M, date2).filter(function (x) { return x.key === key; })[0];
                if (!it) break;
                var next;
                if (act === "skip") next = it.state === "skip" ? "" : "skip";
                else {
                    if (diffDays(date2, today()) > 0) { toast("That day has not come yet."); break; }
                    next = it.state === "done" ? "" : "done";
                }
                enqueue({ type: "tick", key: key, date: date2, state: next }); render(); break;
            }
            case "sync-go": closeSheet(); syncNow(true); break;
            case "clear-notice": S.overridden = 0; save(); openSync(); break;
            case "close": closeSheet(); break;
        }
    });
    document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape" && U.sheet) closeSheet();
        if (ev.key === "Enter" && U.sheet && ev.target && ev.target.id === "hv") { var b = document.querySelector('[data-act="save-value"]'); if (b) b.click(); }
    });
    window.addEventListener("online", function () { render(); renewQuietly(true).then(function () { scheduleSync(500); }); });
    window.addEventListener("offline", function () { render(); });
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) { U.hiddenAt = Date.now(); return; }
        // coming back after a while (or on a new day) is a fresh open: every page goes back to its own day
        if (U.dayStamp !== today() || (U.hiddenAt && Date.now() - U.hiddenAt > AWAY_MS)) { if (!U.sheet) { resetDates(); U.enter = true; } }
        U.hiddenAt = 0;
        render();
        renewQuietly(true).then(function () { scheduleSync(300); });
    });
    setInterval(function () {
        if (document.hidden) return;
        checkRollover();
        renewQuietly(false);   // shortly before the hour is up
        paintChip();
    }, 45000);
    setInterval(function () {
        if (document.hidden) return;
        if (S.queue.length || Date.now() - S.lastSync > 5 * 60000) syncNow(false);
    }, 120000);

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
        navigator.serviceWorker.register("sw.js").catch(function () { /* the app still works, just not offline-first */ });
    }
    window.DUCK = { state: function () { return S; }, model: model, syncNow: syncNow, render: render, version: VERSION, statusFor: statusFor, parseDuration: parseDuration,
                    _t: { stampDay: function (d) { U.dayStamp = d; }, hiddenAt: function (ms) { U.hiddenAt = ms; }, rollover: checkRollover },   // test hooks only
                    dates: function () { return U.dates; }, resetDates: function () { resetDates(); U.enter = true; render(); }, renew: function () { return renewQuietly(true); },
                    schedItems: function (d) { return schedItems(model(), d); }, flushNow: function () { return syncNow(true); } };

    render();
    if (configured() && navigator.onLine) {
        scheduleSync(1200);
        setTimeout(function () { loadGis().then(function () { return renewQuietly(true); }).then(function () { if (S.queue.length) scheduleSync(300); }).catch(function () {}); }, 400);
    }
})();
