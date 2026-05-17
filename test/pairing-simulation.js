#!/usr/bin/env node
// 6人でダブルス(2v2)を N 試合行ったときの、各プレイヤー同士がチームメイトになった
// 回数と確率を出す。matchmaker の index.html のアルゴリズムをミラーしている。
// 実行: node test/pairing-simulation.js
'use strict';

// ====================================================================
// Algorithm (mirrored from /mnt/c/test/matchmaker/index.html)
// ====================================================================

const COOLDOWN = 3;
const COOLDOWN_W = 30;
const NG_WEIGHT = 1e6;

function combinations(n, k) {
  const result = [];
  const recurse = (start, combo) => {
    if (combo.length === k) { result.push(combo.slice()); return; }
    for (let i = start; i < n; i++) {
      combo.push(i); recurse(i + 1, combo); combo.pop();
    }
  };
  recurse(0, []);
  return result;
}

function buildPairHistory(state) {
  const teammate = new Map();
  const opponent = new Map();
  const sameCourtLast = new Map();
  const key = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const add = (m, a, b) => { const k = key(a, b); m.set(k, (m.get(k) || 0) + 1); };
  state.rounds.forEach((r, idx) => {
    r.matches.forEach(m => {
      for (let i = 0; i < m.teamA.length; i++)
        for (let j = i + 1; j < m.teamA.length; j++)
          add(teammate, m.teamA[i].id, m.teamA[j].id);
      for (let i = 0; i < m.teamB.length; i++)
        for (let j = i + 1; j < m.teamB.length; j++)
          add(teammate, m.teamB[i].id, m.teamB[j].id);
      m.teamA.forEach(a => m.teamB.forEach(b => add(opponent, a.id, b.id)));
      const allOnCourt = [...m.teamA, ...m.teamB];
      for (let i = 0; i < allOnCourt.length; i++)
        for (let j = i + 1; j < allOnCourt.length; j++) {
          const k = key(allOnCourt[i].id, allOnCourt[j].id);
          if (!sameCourtLast.has(k)) sameCourtLast.set(k, idx);
        }
    });
  });
  const ng = new Map();
  state.players.forEach(p => {
    if (Array.isArray(p.blacklist) && p.blacklist.length > 0) {
      ng.set(p.id, new Set(p.blacklist));
    }
  });
  return { teammate, opponent, sameCourtLast, ng };
}

function cooldownPenalty(hist, aId, bId) {
  const m = hist.sameCourtLast;
  if (!m) return 0;
  const k = (aId < bId ? aId + "|" + bId : bId + "|" + aId);
  const lastIdx = m.get(k);
  if (lastIdx === undefined || lastIdx >= COOLDOWN) return 0;
  return (COOLDOWN - lastIdx) * COOLDOWN_W;
}

function isNGPair(hist, a, b) {
  const sa = hist.ng && hist.ng.get(a);
  return sa ? sa.has(b) : false;
}

function bestSplit(players, hist) {
  const key = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const get = (m, a, b) => m.get(key(a, b)) || 0;
  const sq = x => x * x;
  const n = players.length;
  const teamSize = n / 2;
  let best = null;
  let bestScore = Infinity;
  const combos = combinations(n, teamSize);
  for (const idxA of combos) {
    const setA = new Set(idxA);
    const teamA = idxA.map(i => players[i]);
    const teamB = players.filter((_, i) => !setA.has(i));
    let score = 0;
    for (let i = 0; i < teamSize; i++)
      for (let j = i + 1; j < teamSize; j++) {
        score += sq(get(hist.teammate, teamA[i].id, teamA[j].id)) * 3;
        score += cooldownPenalty(hist, teamA[i].id, teamA[j].id);
        if (isNGPair(hist, teamA[i].id, teamA[j].id)) score += NG_WEIGHT;
        score += sq(get(hist.teammate, teamB[i].id, teamB[j].id)) * 3;
        score += cooldownPenalty(hist, teamB[i].id, teamB[j].id);
        if (isNGPair(hist, teamB[i].id, teamB[j].id)) score += NG_WEIGHT;
      }
    for (let i = 0; i < teamSize; i++)
      for (let j = 0; j < teamSize; j++) {
        score += sq(get(hist.opponent, teamA[i].id, teamB[j].id)) * 2;
        score += cooldownPenalty(hist, teamA[i].id, teamB[j].id);
      }
    score += Math.random() * 0.01;
    if (score < bestScore) { bestScore = score; best = { teamA, teamB, score }; }
  }
  return best;
}

function assignToCourts(playing, courtSpecs, hist, gbf) {
  const sq = x => x * x;
  const sizes = courtSpecs.map(c => c.format === "1v1" ? 2 : c.format === "2v2" ? 4 : 6);
  let best = null;
  let bestTotal = Infinity;
  const trials = courtSpecs.length === 1 ? 1 : 500;
  for (let t = 0; t < trials; t++) {
    const shuffled = [...playing];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let total = 0;
    const matches = [];
    let cursor = 0;
    for (let c = 0; c < courtSpecs.length; c++) {
      const size = sizes[c];
      const fmt = courtSpecs[c].format;
      const group = shuffled.slice(cursor, cursor + size);
      cursor += size;
      group.forEach(p => {
        const counts = gbf && gbf.get(p.id);
        const cnt = (counts && counts[fmt]) || 0;
        total += sq(cnt) * 2;
      });
      const split = bestSplit(group, hist);
      total += split.score;
      matches.push({ courtNumber: c + 1, format: fmt, teamA: split.teamA, teamB: split.teamB });
    }
    if (total < bestTotal) { bestTotal = total; best = matches; }
  }
  return best;
}

// 簡略化した generateNextRound。全員 isActive、skill 区分なし、全コートが 2v2。
function generateRound(state, numCourts2v2) {
  const hist = buildPairHistory(state);
  const gbf = new Map(state.players.map(p => [p.id, p.gamesByFormat]));
  const active = state.players.filter(p => p.isActive);
  const priority = p => p.gamesPlayed + (p.skipCount || 0);
  const keyed = active.map(p => ({ p, r: Math.random() }));
  keyed.sort((a, b) => {
    const pa = priority(a.p), pb = priority(b.p);
    if (pa !== pb) return pa - pb;
    return a.r - b.r;
  });
  const sorted = keyed.map(x => x.p);
  const needed = numCourts2v2 * 4;
  const playing = sorted.slice(0, needed);
  const resting = sorted.slice(needed);

  const courtSpecs = Array.from({ length: numCourts2v2 }, () => ({ format: "2v2" }));
  const matches = assignToCourts(
    playing.map(p => ({ id: p.id, name: p.name })),
    courtSpecs,
    hist,
    gbf
  );

  playing.forEach(p => {
    p.gamesPlayed += 1;
    p.gamesByFormat["2v2"] += 1;
  });

  state.rounds.unshift({
    roundNumber: state.rounds.length + 1,
    matches,
    resting: resting.map(p => ({ id: p.id, name: p.name })),
    timestamp: Date.now(),
  });
}

// ====================================================================
// Simulation
// ====================================================================

const NAMES = ["田中", "佐藤", "鈴木", "高橋", "伊藤", "渡辺", "山本", "中村", "小林", "加藤", "吉田", "山田", "佐々木"];

function makeState(numPlayers) {
  const state = { players: [], rounds: [] };
  for (let i = 0; i < numPlayers; i++) {
    state.players.push({
      id: "P" + i,
      name: NAMES[i] || "P" + i,
      isActive: true,
      skill: "lower",
      gamesPlayed: 0,
      skipCount: 0,
      blacklist: [],
      gamesByFormat: { "1v1": 0, "2v2": 0, "3v3": 0 },
    });
  }
  return state;
}

function simulate(numPlayers, numRounds, numCourts2v2, seed) {
  if (typeof seed === "number") {
    let s = seed >>> 0;
    Math.random = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const state = makeState(numPlayers);
  for (let r = 0; r < numRounds; r++) generateRound(state, numCourts2v2);
  return state;
}

function pairCounts(state) {
  const counts = {};
  state.players.forEach(p => { counts[p.id] = {}; state.players.forEach(q => { if (p.id !== q.id) counts[p.id][q.id] = 0; }); });
  state.rounds.forEach(r => {
    r.matches.forEach(m => {
      [m.teamA, m.teamB].forEach(team => {
        for (let i = 0; i < team.length; i++)
          for (let j = 0; j < team.length; j++)
            if (i !== j) counts[team[i].id][team[j].id] += 1;
      });
    });
  });
  return counts;
}

function pad(s, w) { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function padR(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }

// 簡易的に「日本語文字 = 2幅」とみなして右パディング
function padJP(s, w) {
  const visualW = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  if (visualW >= w) return s;
  return s + " ".repeat(w - visualW);
}

function printOne(label, numPlayers, numCourts, numRounds, runs) {
  const sumCounts = {};
  const sumGames = {};
  let firstState = null;
  for (let r = 0; r < runs; r++) {
    const state = simulate(numPlayers, numRounds, numCourts, r + 1);
    if (!firstState) firstState = state;
    const c = pairCounts(state);
    state.players.forEach(p => {
      sumGames[p.id] = (sumGames[p.id] || 0) + p.gamesPlayed;
      sumCounts[p.id] = sumCounts[p.id] || {};
      Object.keys(c[p.id]).forEach(qid => {
        sumCounts[p.id][qid] = (sumCounts[p.id][qid] || 0) + c[p.id][qid];
      });
    });
  }
  const players = firstState.players;

  console.log("\n" + "=".repeat(72));
  console.log(`${label}: ${numPlayers}人ダブルス(2v2 × ${numCourts}コート) を ${numRounds} 試合 × ${runs} 回シミュレート(平均)`);
  console.log("=".repeat(72));

  // 平均ペア回数
  console.log("\n各プレイヤーと他のプレイヤーがチームメイトになった平均回数:");
  process.stdout.write(padJP("", 8));
  players.forEach(p => process.stdout.write(padJP(p.name, 8)));
  console.log("  平均出場数");
  players.forEach(p => {
    process.stdout.write(padJP(p.name, 8));
    players.forEach(q => {
      if (p.id === q.id) process.stdout.write(padJP("—", 8));
      else {
        const avg = sumCounts[p.id][q.id] / runs;
        process.stdout.write(pad(avg.toFixed(2), 6) + "  ");
      }
    });
    const avgG = sumGames[p.id] / runs;
    console.log("  " + avgG.toFixed(2));
  });

  // 確率(X が出場した試合のうち Y とチームメイトだった割合)
  console.log("\n出場試合あたり Y とチームメイトだった割合 (%):");
  process.stdout.write(padJP("", 8));
  players.forEach(p => process.stdout.write(padJP(p.name, 8)));
  console.log("");
  players.forEach(p => {
    process.stdout.write(padJP(p.name, 8));
    players.forEach(q => {
      if (p.id === q.id) process.stdout.write(padJP("—", 8));
      else {
        const avgC = sumCounts[p.id][q.id] / runs;
        const avgG = sumGames[p.id] / runs;
        const pct = avgG > 0 ? (avgC / avgG) * 100 : 0;
        process.stdout.write(pad(pct.toFixed(1) + "%", 6) + "  ");
      }
    });
    console.log("");
  });
}

function biasAnalysis(numPlayers, numCourts, numRounds, runs) {
  const allPairCounts = [];
  const allGames = [];
  const allRests = [];
  for (let r = 0; r < runs; r++) {
    const state = simulate(numPlayers, numRounds, numCourts, r + 1000);
    const c = pairCounts(state);
    const pairs = [];
    for (let i = 0; i < state.players.length; i++)
      for (let j = i + 1; j < state.players.length; j++)
        pairs.push(c[state.players[i].id][state.players[j].id]);
    allPairCounts.push(pairs);
    allGames.push(state.players.map(p => p.gamesPlayed));
    allRests.push(state.players.map(p => numRounds - p.gamesPlayed));
  }
  const flat = allPairCounts.flat();
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const variance = flat.reduce((a, b) => a + (b - mean) ** 2, 0) / flat.length;
  const std = Math.sqrt(variance);
  const spreads = allPairCounts.map(arr => Math.max(...arr) - Math.min(...arr));
  const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const maxSpread = Math.max(...spreads);
  const minSpread = Math.min(...spreads);
  const gameSpreads = allGames.map(arr => Math.max(...arr) - Math.min(...arr));
  const avgGameSpread = gameSpreads.reduce((a, b) => a + b, 0) / gameSpreads.length;
  const maxGameSpread = Math.max(...gameSpreads);

  // 休み回数の統計
  const restFlat = allRests.flat();
  const restMean = restFlat.reduce((a, b) => a + b, 0) / restFlat.length;
  const restMin = Math.min(...restFlat);
  const restMax = Math.max(...restFlat);

  // ペア回数ヒストグラム
  const hist = {};
  flat.forEach(v => { hist[v] = (hist[v] || 0) + 1; });
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);

  // 休み回数ヒストグラム
  const restHist = {};
  restFlat.forEach(v => { restHist[v] = (restHist[v] || 0) + 1; });
  const restKeys = Object.keys(restHist).map(Number).sort((a, b) => a - b);

  console.log("\n" + "=".repeat(72));
  console.log(`偏り分析: ${numPlayers}人ダブルス × ${numCourts}コート × ${numRounds}試合 × ${runs}試行`);
  console.log("=".repeat(72));
  console.log(`  ペア回数 平均: ${mean.toFixed(3)}  標準偏差: ${std.toFixed(3)}`);
  console.log(`  1試行内のペア回数スプレッド(max - min): 平均 ${avgSpread.toFixed(2)} / 最小 ${minSpread} / 最大 ${maxSpread}`);
  console.log(`  1試行内の出場数スプレッド(max - min): 平均 ${avgGameSpread.toFixed(2)} / 最大 ${maxGameSpread}`);
  console.log(`  休み回数: 平均 ${restMean.toFixed(2)} / 最小 ${restMin} / 最大 ${restMax}`);

  const numPairs = numPlayers * (numPlayers - 1) / 2;
  console.log(`\n  ペア回数の分布 (全 ${runs}試行 × ${numPairs}ペア = ${flat.length} サンプル):`);
  const maxBarUnit = Math.max(...Object.values(hist));
  keys.forEach(k => {
    const cnt = hist[k];
    const pct = (cnt / flat.length * 100).toFixed(1);
    const bar = "█".repeat(Math.round(cnt / maxBarUnit * 30));
    console.log(`    ${pad(k, 3)} 回: ${pad(cnt, 5)} (${pad(pct, 5)}%) ${bar}`);
  });

  console.log(`\n  休み回数の分布 (全 ${runs}試行 × ${numPlayers}人 = ${restFlat.length} サンプル):`);
  const maxRestBar = Math.max(...Object.values(restHist));
  restKeys.forEach(k => {
    const cnt = restHist[k];
    const pct = (cnt / restFlat.length * 100).toFixed(1);
    const bar = "█".repeat(Math.round(cnt / maxRestBar * 30));
    console.log(`    ${pad(k, 3)} 回: ${pad(cnt, 5)} (${pad(pct, 5)}%) ${bar}`);
  });
}

// ===== 6人ダブルス(1コート) =====
console.log("【6人ダブルス(2v2 × 1コート)】");
console.log("理論値(完全均等の場合):");
console.log("  - 各プレイヤーの出場試合数 ≈ N × 4/6 = N × 0.667");
console.log("  - 各ペアの平均チームメイト回数 ≈ N × 2/15");
console.log("    → 20試合: 2.67回 / 30試合: 4.00回 / 50試合: 6.67回");
console.log("  - X が出場した試合で特定 Y がチームメイトだった確率 ≈ 20%");

const RUNS = 200;
printOne(`50 試合`, 6, 1, 50, RUNS);
biasAnalysis(6, 1, 50, 500);

// ===== 13人ダブルス(3コート) =====
console.log("\n\n");
console.log("█".repeat(72));
console.log("【13人ダブルス(2v2 × 3コート = 12人出場/1人休憩)】");
console.log("█".repeat(72));
console.log("理論値(完全均等の場合):");
console.log("  - 各プレイヤーの出場試合数 ≈ N × 12/13 ≈ N × 0.923");
console.log("  - 各プレイヤーの休み回数 ≈ N × 1/13 ≈ N × 0.077");
console.log("  - 各ペアの平均チームメイト回数 ≈ N × 6/(13×12/2) = N × 6/78 ≈ N × 0.0769");
console.log("    (1試合6チームメイトペア / 13C2=78ペア)");
console.log("    → 20試合: 1.54回 / 30試合: 2.31回 / 50試合: 3.85回");
console.log("  - X が出場した試合で特定 Y がチームメイトだった確率");
console.log("    = P(Y出場|X出場) × P(Yがチームメイト|両者出場) = (11/12) × (1/11) = 1/12 ≈ 8.33%");

printOne(`50 試合`, 13, 3, 50, RUNS);
biasAnalysis(13, 3, 50, 200);
