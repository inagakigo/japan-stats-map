// fetch-data.js — 全 API データを取得して data/*.json に保存
// 使い方: node fetch-data.js [metric1 metric2 ...]  （引数なしで全部）
//
// 出力:
//   data/pref.topojson           都道府県ポリゴン (TopoJSON)
//   data/cities.topojson         市町村ポリゴン (TopoJSON)
//   data/population.json         Wikidata 人口
//   data/forest.json             e-Stat 林野面積
//   data/density.json            e-Stat 人口密度 (算出)
//   data/restaurant.json         e-Stat 飲食店/千人
//   data/aging.json              e-Stat 高齢化率
//   data/avgAge.json             e-Stat 平均年齢 (推定)
//   data/vacancy.json            e-Stat 空き家率
//   data/_ssds_pop.json          SSDS 総人口 (popup fallback 用)
//   data/earthquake-raw.json     USGS 生 GeoJSON (assignment は実行時)
//
// 各 JSON は Map.entries 形式: [[code5, value], ...]

import fs from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "data");
const ESTAT_APP_ID = "1f82bb965bfccadf7a37a5654778234ddeec3a73";
const SPARQL = "https://query.wikidata.org/sparql";
const PREF_URL = "https://raw.githubusercontent.com/dataofjapan/land/master/japan.topojson";
const CITIES_URL = "https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/topojson/s0001/N03-21_210101.json";

await fs.mkdir(OUT, { recursive: true });

async function writeEntries(name, map) {
  const entries = Array.from(map.entries());
  await fs.writeFile(path.join(OUT, `${name}.json`), JSON.stringify(entries));
  console.log(`  → wrote ${name}.json (${entries.length} entries)`);
}

async function writeRaw(name, obj) {
  await fs.writeFile(path.join(OUT, name), JSON.stringify(obj));
  console.log(`  → wrote ${name}`);
}

// ----- topojson -----
async function fetchTopojsons() {
  console.log("[topo] pref...");
  const pref = await (await fetch(PREF_URL)).json();
  await writeRaw("pref.topojson", pref);
  console.log("[topo] cities...");
  const cities = await (await fetch(CITIES_URL)).json();
  await writeRaw("cities.topojson", cities);
}

// ----- Wikidata 人口 -----
async function fetchPopulation() {
  console.log("[population] SPARQL...");
  const query = `
    SELECT ?lgcode ?pop ?date ?rank WHERE {
      ?city wdt:P429 ?lgcode .
      ?city p:P1082 ?stmt .
      ?stmt ps:P1082 ?pop .
      ?stmt wikibase:rank ?rank .
      OPTIONAL { ?stmt pq:P585 ?date . }
    }
  `;
  const url = `${SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept": "application/sparql-results+json", "User-Agent": "japan-stats-map/1.0 (https://github.com/inagakigo/japan-stats-map)" } });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
  const data = await res.json();
  const rankScore = (r) => {
    if (r?.endsWith("PreferredRank")) return 3;
    if (r?.endsWith("DeprecatedRank")) return 1;
    return 2;
  };
  const tmp = new Map();
  for (const b of data.results.bindings) {
    const code5 = String(b.lgcode.value).slice(0, 5);
    const pop = Number(b.pop.value);
    if (!isFinite(pop) || pop <= 0) continue;
    const date = b.date?.value || "";
    const rank = rankScore(b.rank?.value || "");
    const prev = tmp.get(code5);
    let take = !prev;
    if (prev) {
      if (rank !== prev.rank) take = rank > prev.rank;
      else if (date && prev.date) take = date > prev.date;
      else if (date && !prev.date) take = true;
      else take = false;
    }
    if (take) tmp.set(code5, { pop, date, rank });
  }
  const map = new Map();
  for (const [k, v] of tmp) map.set(k, v.pop);
  await writeEntries("population", map);
}

// ----- SSDS テーブル列挙 / メタ -----
let _ssdsTablesPromise = null;
const _ssdsMetaCache = new Map();
async function getSSDSMunicipalTables() {
  if (_ssdsTablesPromise) return _ssdsTablesPromise;
  _ssdsTablesPromise = (async () => {
    const url = `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsList?appId=${ESTAT_APP_ID}&statsCode=00200502&limit=200`;
    const json = await (await fetch(url)).json();
    const t = json.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF || [];
    const arr = (Array.isArray(t) ? t : [t]).filter(x => /^0000020/.test(String(x["@id"])));
    console.log(`  [ssds] tables cached: ${arr.length}`);
    return arr;
  })();
  return _ssdsTablesPromise;
}
async function getSSDSMeta(tid) {
  if (_ssdsMetaCache.has(tid)) return _ssdsMetaCache.get(tid);
  const p = (async () => {
    const url = `https://api.e-stat.go.jp/rest/3.0/app/json/getMetaInfo?appId=${ESTAT_APP_ID}&statsDataId=${tid}`;
    const json = await (await fetch(url)).json();
    const x = json.GET_META_INFO?.METADATA_INF?.CLASS_INF?.CLASS_OBJ;
    return Array.isArray(x) ? x : x ? [x] : [];
  })();
  _ssdsMetaCache.set(tid, p);
  return p;
}

// "先に見つかったヒットを使う" 型 (forest, restaurant)
async function fetchSSDSMetric(tag, nameRegex, excludeRegex = /(率|割合|比|構成比|当たり)/) {
  const arr = await getSSDSMunicipalTables();
  for (const t of arr) {
    const tid = t["@id"];
    const co = await getSSDSMeta(tid);
    let hit = null;
    for (const c of co) {
      const items = Array.isArray(c.CLASS) ? c.CLASS : [c.CLASS];
      for (const it of items) {
        const name = String(it?.["@name"] || "");
        const code = String(it?.["@code"] || "");
        if (nameRegex.test(name) && !excludeRegex.test(name)) {
          hit = { tid, catId: c["@id"], code, name };
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) continue;
    const catParam = "cd" + hit.catId.charAt(0).toUpperCase() + hit.catId.slice(1);
    const catField = "@" + hit.catId;
    const dataUrl = `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData?appId=${ESTAT_APP_ID}&statsDataId=${hit.tid}&${catParam}=${hit.code}&limit=100000`;
    const json = await (await fetch(dataUrl)).json();
    if (json.GET_STATS_DATA?.RESULT?.STATUS !== 0) continue;
    const values = (json.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE || [])
      .filter(v => String(v[catField] || "") === hit.code);
    const latest = new Map();
    for (const v of values) {
      const area = String(v["@area"] || "");
      if (!/^\d{5}$/.test(area)) continue;
      const year = String(v["@time"] || "");
      const val = Number(v["$"]);
      if (!isFinite(val) || val <= 0) continue;
      const cur = latest.get(area);
      if (!cur || year > cur.year) latest.set(area, { year, val });
    }
    if (latest.size > 0) {
      const map = new Map();
      for (const [c, info] of latest) map.set(c, info.val);
      console.log(`  [${tag}] picked ${hit.tid}/${hit.code} "${hit.name}" → ${map.size}`);
      return map;
    }
  }
  throw new Error(`${tag}: not found`);
}

// "最大ヒット数を選ぶ" 型 (aging, vacancy, avgAge の総人口など)
async function fetchBestSSDSMetric(tag, nameRegex, excludeRegex) {
  const arr = await getSSDSMunicipalTables();
  let best = null;
  for (const t of arr) {
    const tid = t["@id"];
    const co = await getSSDSMeta(tid);
    for (const c of co) {
      const items = Array.isArray(c.CLASS) ? c.CLASS : [c.CLASS];
      for (const it of items) {
        const name = String(it?.["@name"] || "");
        const code = String(it?.["@code"] || "");
        if (!nameRegex.test(name) || excludeRegex.test(name)) continue;
        const catParam = "cd" + c["@id"].charAt(0).toUpperCase() + c["@id"].slice(1);
        const catField = "@" + c["@id"];
        const dataUrl = `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData?appId=${ESTAT_APP_ID}&statsDataId=${tid}&${catParam}=${code}&limit=100000`;
        const json = await (await fetch(dataUrl)).json();
        if (json.GET_STATS_DATA?.RESULT?.STATUS !== 0) continue;
        const vals = (json.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE || [])
          .filter(v => String(v[catField] || "") === code);
        const latest = new Map();
        for (const v of vals) {
          const area = String(v["@area"] || "");
          if (!/^\d{5}$/.test(area)) continue;
          const year = String(v["@time"] || "");
          const val = Number(v["$"]);
          if (!isFinite(val) || val <= 0) continue;
          const cur = latest.get(area);
          if (!cur || year > cur.year) latest.set(area, { year, val });
        }
        if (latest.size > (best?.size || 0)) {
          best = { tid, code, name, size: latest.size, latest };
        }
      }
    }
  }
  if (!best) throw new Error(`${tag}: not found`);
  console.log(`  [${tag}] picked ${best.tid}/${best.code} "${best.name}" → ${best.size}`);
  const map = new Map();
  for (const [k, v] of best.latest) map.set(k, v.val);
  return map;
}

// ----- 各指標 -----
async function fetchForest() {
  console.log("[forest]");
  const m = await fetchSSDSMetric("forest", /林野面積/);
  await writeEntries("forest", m);
}
async function fetchRestaurant() {
  console.log("[restaurant]");
  const m = await fetchSSDSMetric("restaurant", /飲食店数.*人口.*当たり/, /(率|割合|構成比)/);
  await writeEntries("restaurant", m);
}

let _ssdsPopCache = null;
async function getSSDSPop() {
  if (_ssdsPopCache) return _ssdsPopCache;
  console.log("[_ssds_pop]");
  _ssdsPopCache = await fetchBestSSDSMetric("_ssds_pop", /総人口/, /(率|割合|当たり|構成比|男|女|外国人|未満|以上|歳|昼間|夜間|世帯|増減)/);
  await writeEntries("_ssds_pop", _ssdsPopCache);
  return _ssdsPopCache;
}

async function fetchDensity() {
  console.log("[density]");
  const popMap = await getSSDSPop();
  const areaMap = await fetchBestSSDSMetric("density-area", /総面積/, /(率|割合|当たり|構成比|可住地)/);
  const samples = [];
  for (const code of ["13116", "13101", "13104"]) {
    const p = popMap.get(code), a = areaMap.get(code);
    if (p && a) samples.push({ code, p, a, r: p / a });
  }
  const avgR = samples.length ? samples.reduce((s, x) => s + x.r, 0) / samples.length : 0;
  const multiplier = (avgR > 0 && avgR < 2000) ? 100 : 1;
  console.log(`  [density] multiplier=${multiplier}`);
  const density = new Map();
  for (const [code, pop] of popMap) {
    const area = areaMap.get(code);
    if (!area || area <= 0) continue;
    density.set(code, Math.round(pop / area * multiplier));
  }
  await writeEntries("density", density);
}

async function fetchAging() {
  console.log("[aging]");
  try {
    const direct = await fetchBestSSDSMetric("aging", /(65歳以上.*人口.*割合|高齢化率)/, /(男|女|外国|未満|世帯|増減|構成比|.*男$|.*女$)/);
    if (direct.size > 0) {
      await writeEntries("aging", direct);
      return;
    }
  } catch (_) {}
  const totalPop = await getSSDSPop();
  const elderPop = await fetchBestSSDSMetric("aging-elder", /65歳以上.*人口/, /(率|割合|当たり|構成比|男|女|外国人|世帯|増減|未婚|有配偶|死別)/);
  const rate = new Map();
  for (const [code, eld] of elderPop) {
    const tot = totalPop.get(code);
    if (tot && tot > 0) rate.set(code, +(eld / tot * 100).toFixed(1));
  }
  await writeEntries("aging", rate);
}

async function fetchAvgAge() {
  console.log("[avgAge]");
  const total = await getSSDSPop();
  const youth = await fetchBestSSDSMetric("avgAge-youth", /0.{0,2}14歳.*人口|15歳未満.*人口|年少人口/, /(率|割合|当たり|構成比|男|女|外国人|世帯)/);
  const adult = await fetchBestSSDSMetric("avgAge-adult", /15.{0,2}64歳.*人口|生産年齢人口/, /(率|割合|当たり|構成比|男|女|外国人|世帯)/);
  const elder = await fetchBestSSDSMetric("avgAge-elder", /65歳以上.*人口/, /(率|割合|当たり|構成比|男|女|外国人|世帯|増減)/);
  const MID_YOUTH = 7, MID_ADULT = 40, MID_ELDER = 75;
  const map = new Map();
  for (const [code, tot] of total) {
    const y = youth.get(code) || 0;
    const a = adult.get(code) || 0;
    const e = elder.get(code) || 0;
    const sum = y + a + e;
    if (sum > 0 && tot > 0) {
      const ageEst = (y * MID_YOUTH + a * MID_ADULT + e * MID_ELDER) / sum;
      map.set(code, +ageEst.toFixed(1));
    }
  }
  await writeEntries("avgAge", map);
}

async function fetchVacancy() {
  console.log("[vacancy]");
  const m = await fetchBestSSDSMetric("vacancy", /空き家.*率|空き家率/, /(男|女|外国人|戸数|世帯|二次的|別荘)/);
  await writeEntries("vacancy", m);
}

// ----- 水の郷百選 (Wikipedia から抽出) -----
async function fetchWaterVillage100() {
  console.log("[water100]");
  const url = "https://ja.wikipedia.org/w/api.php?action=parse&page=%E6%B0%B4%E3%81%AE%E9%83%B7%E7%99%BE%E9%81%B8&format=json&prop=wikitext";
  const json = await (await fetch(url)).json();
  const wt = json.parse?.wikitext?.["*"] || "";
  if (!wt) throw new Error("水の郷百選 wikitext empty");

  // table 行を走査して (prefName, cityName) を抽出
  const lines = wt.split("\n");
  const pairs = []; // [pref, city]
  let curPref = null;
  let pendingPref = 0; // rowspan 残量

  // [[Foo]] や [[Foo (Bar)|Foo]] → "Foo" (表示名)
  const linkText = (s) => {
    const m = s.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
    if (!m) return null;
    return (m[2] || m[1]).trim();
  };
  const allLinks = (s) => {
    const out = [];
    const re = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
    let m;
    while ((m = re.exec(s))) out.push((m[2] || m[1]).trim());
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 行内に「rowspan="N"|[[県名]]」の形がある場合 → 県を更新
    const prefMatch = line.match(/rowspan="(\d+)"\|\[\[([^\]|]+(?:県|府|都|道))\]\]/);
    if (prefMatch) {
      curPref = prefMatch[2];
      pendingPref = Number(prefMatch[1]);
      // 同じ行に市町村セルがある場合 (テーブル冒頭)
      // → 同行 "|[[City]]" は普通次の行 — table format
    }
    // rowspan なしの「|[[県名]]」(1 件しかない県)
    const simplePref = line.match(/^\|\s*\[\[([^\]|]+(?:県|府|都|道))\]\]\s*$/);
    if (simplePref) {
      curPref = simplePref[1];
      pendingPref = 1;
    }
    // 市町村セル: "|<text>" だが prefcell ではない / 行頭が "|-" でも "|}" でもない
    // 簡易判定: 行頭が "|" で、行内に "[[" を含み、かつ rowspan/colspan 風でない
    if (/^\|[^\-}]/.test(line) && !prefMatch && !simplePref && curPref) {
      // 県以外の wiki link を抽出。「現、XXX」「現:XXX」「現・XXX」 が含まれる場合は () 内のリンクを優先
      const genMatch = line.match(/[（(]現[、:：・,]\s*([^）)]+)[）)]/);
      let names = [];
      if (genMatch) {
        names = allLinks(genMatch[1]);
        if (!names.length) {
          // [[link]] が無い場合は素のテキスト(例: 「現、加須市」)を分割
          names = genMatch[1]
            .split(/[、,]/)
            .map(s => s.trim())
            .filter(s => /(市|町|村|区)$/.test(s));
        }
      }
      if (!names.length) {
        // 旧名 1 つの場合: 最初の [[link]] を使う
        const n = linkText(line);
        if (n) names = [n];
      }
      // 複数旧自治体 + 1 現の場合 (例: 嶺北地域 や 安曇野) は genMatch を取れている
      // 複数旧自治体 + 複数現の場合は両方
      // それ以外で行内に複数の [[市町村]] link がある場合 (旧自治体併記の括弧):
      // 「(豊科町、穂高町、明科町)」のような旧自治体は除外したい
      // → genMatch が取れた行はそれを優先
      if (!names.length) continue;
      // 県名と被ったら除外
      names = names.filter(n => n !== curPref && !/^(現|主な|参照|詳細)$/.test(n));
      for (const name of names) {
        pairs.push([curPref, name]);
      }
    }
    // テーブル終了
    if (line.startsWith("|}")) {
      pendingPref = 0;
    }
  }

  // ユニーク化 ("pref|city" key)
  const seen = new Set();
  const uniq = [];
  for (const [p, c] of pairs) {
    const k = `${p}|${c}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push([p, c]);
  }
  console.log(`  [water100] extracted ${uniq.length} pairs`);
  await fs.writeFile(path.join(OUT, "water100.json"), JSON.stringify(uniq));
  console.log(`  → wrote water100.json`);
}

// ----- 日本百名山 -----
async function fetchHyakumeizan() {
  console.log("[hyakumeizan]");
  // 1. カテゴリ「日本百名山」のページ一覧を取得
  const catUrl = "https://ja.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:%E6%97%A5%E6%9C%AC%E7%99%BE%E5%90%8D%E5%B1%B1&cmlimit=200&cmtype=page&format=json";
  const catJson = await (await fetch(catUrl)).json();
  const members = (catJson.query?.categorymembers || [])
    .map(x => x.title)
    .filter(t => t !== "日本百名山" && t !== "深田クラブ" && !t.startsWith("Category:"));
  console.log(`  [hyakumeizan] ${members.length} mountain pages`);

  // 2. 各ページの wikitext を取得 → Infobox 所在地 から (pref, muni) を抽出
  // バッチ取得: titles= を | 区切りで複数指定 (50件まで OK)
  const allPairs = [];
  for (let i = 0; i < members.length; i += 20) {
    const batch = members.slice(i, i + 20);
    // parse API は 1 ページずつ。query API で revisions を取って rvprop=content の方が高速
    const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(batch.join("|"))}&rvprop=content&rvslots=main&format=json&formatversion=2`;
    const json = await (await fetch(url)).json();
    const pages = json.query?.pages || [];
    for (const p of pages) {
      const wt = p.revisions?.[0]?.slots?.main?.content || "";
      const pairs = extractMountainLocations(wt, p.title);
      for (const pair of pairs) allPairs.push(pair);
    }
  }

  // ユニーク化
  const seen = new Set();
  const uniq = [];
  for (const [p, c, mountain] of allPairs) {
    const k = `${p}|${c}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push([p, c]);
  }
  console.log(`  [hyakumeizan] extracted ${allPairs.length} pairs, ${uniq.length} unique muni`);
  await fs.writeFile(path.join(OUT, "hyakumeizan.json"), JSON.stringify(uniq));
  console.log(`  → wrote hyakumeizan.json`);
}

const PREF_SET = new Set([
  "北海道",
  "青森県","岩手県","宮城県","秋田県","山形県","福島県",
  "茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
  "新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県",
  "滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県",
  "徳島県","香川県","愛媛県","高知県",
  "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"
]);
function extractLocationPairsFromBlock(block) {
  if (!block) return [];
  const linkRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  const pairs = [];
  let curPref = null;
  let mm;
  while ((mm = linkRe.exec(block))) {
    const baseName = mm[1].trim().replace(/\s*\([^)]*\)\s*$/, "");
    if (PREF_SET.has(baseName)) {
      curPref = baseName;
    } else if (/郡$/.test(baseName)) {
      // skip
    } else if (/(市|町|村)$/.test(baseName) && curPref) {
      pairs.push([curPref, baseName]);
    }
  }
  return pairs;
}

function extractMountainLocations(wikitext, title) {
  if (!wikitext) return [];
  // Infobox の「所在地」フィールドを切り出す
  // |所在地 = ... (次の |xxx = まで)
  const m = wikitext.match(/\|\s*所在地\s*=\s*([\s\S]*?)(?=\n\s*\|\s*\w|\n\}\})/);
  if (!m) return [];
  const block = m[1];

  // [[県名]] と [[市/町/村/区名]] のリンクを順に抽出
  // 「都 / 道 / 府 / 県」で終わるリンクは pref、「市 / 町 / 村」(または末尾が区) は muni
  // 郡 はスキップ
  const linkRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  const pairs = [];
  let curPref = null;
  let curCity = null;  // 政令市の区がある場合の保留
  let mm;
  while ((mm = linkRe.exec(block))) {
    const name = mm[1].trim();
    // 「県名 (xxx)」のような曖昧さ回避は本体名だけに
    const baseName = name.replace(/\s*\([^)]*\)\s*$/, "");
    if (/(都|道|府|県)$/.test(baseName) && baseName !== "都道府県") {
      curPref = baseName;
      curCity = null;
    } else if (/郡$/.test(baseName)) {
      // 郡はスキップ (次に町村が来る)
    } else if (/(市|町|村)$/.test(baseName) && curPref) {
      pairs.push([curPref, baseName, title]);
      curCity = baseName;
    } else if (/区$/.test(baseName) && curPref) {
      // 区は政令市の区 — 直前の市 (curCity) と組み合わせる必要があるが、
      // nationalNameLookup は「市」で当てれば DC は全体ヒットするので muni=市 のままで十分
    }
  }
  return pairs;
}

// ----- 原発所在地 -----
async function fetchNuclearPlants() {
  console.log("[nuclear]");
  const url = "https://ja.wikipedia.org/w/api.php?action=parse&page=%E6%97%A5%E6%9C%AC%E3%81%AE%E5%8E%9F%E5%AD%90%E5%8A%9B%E7%99%BA%E9%9B%BB%E6%89%80&format=json&prop=wikitext";
  const json = await (await fetch(url)).json();
  const wt = json.parse?.wikitext?.["*"] || "";
  if (!wt) throw new Error("nuclear wikitext empty");

  // テーブルとその直前の見出しを並列に取得
  const lines = wt.split("\n");
  let curHeading = "";
  const tables = []; // { heading, content }
  let buf = null;
  for (const line of lines) {
    const h = line.match(/^={2,}\s*(.+?)\s*={2,}\s*$/);
    if (h) curHeading = h[1];
    if (line.startsWith("{|")) buf = { heading: curHeading, content: [line] };
    else if (buf) {
      buf.content.push(line);
      if (line.startsWith("|}")) { tables.push(buf); buf = null; }
    }
  }
  console.log(`  [nuclear] tables: ${tables.map(t => t.heading).join(" / ")}`);

  // 運用中/建設中/廃止解体中は status=1 (現存), 建設中止/計画中止は status=2
  const tableStatus = (h) => {
    if (/中止/.test(h)) return 2;
    if (/(地域経済|脚注|関連)/.test(h)) return null;
    return 1;
  };
  const targetTables = tables
    .map(t => ({ ...t, status: tableStatus(t.heading) }))
    .filter(t => t.status !== null);

  const pairs = [];
  const seen = new Set();
  // [[Target]] または [[Target|Display]] のリンクを順に走査し、
  // 県 → (郡) → 市/町/村 のシーケンスを見つけたら採用
  const linkRe = /\[\[([^\]]+?)\]\]/g;
  const cleanName = (s) => {
    // |Display があれば Display を、なければ Target を採用
    const parts = s.split("|");
    let name = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
    // 曖昧さ回避 「美浜町 (福井県)」→「美浜町」
    name = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
    return name;
  };
  for (const t of targetTables) {
    const text = t.content.join("\n").replace(/\{\{Display none\|[^}]*\}\}/g, "");
    let curPref = null;
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(text))) {
      const name = cleanName(m[1]);
      if (/(都|道|府|県)$/.test(name) && name !== "都道府県") {
        curPref = name;
      } else if (/郡$/.test(name)) {
        // skip
      } else if (/(市|町|村)$/.test(name) && curPref) {
        const k = curPref + "|" + name;
        if (seen.has(k)) continue;
        // 現存テーブルで既に追加済みのものは中止テーブルでは上書きしない
        seen.add(k);
        pairs.push([curPref, name, t.status]);
      }
    }
  }
  const active = pairs.filter(p => p[2] === 1).length;
  const cancelled = pairs.filter(p => p[2] === 2).length;
  console.log(`  [nuclear] active=${active} cancelled=${cancelled} total=${pairs.length}`);
  await fs.writeFile(path.join(OUT, "nuclear.json"), JSON.stringify(pairs));
  console.log(`  → wrote nuclear.json`);
}

// ----- 大規模ダム (堤高100m以上) -----
async function fetchLargeDams() {
  console.log("[dam]");
  // 1. 日本のダム一覧の「堤高順」セクションから、ダム名と堤高を抽出
  const listUrl = "https://ja.wikipedia.org/w/api.php?action=parse&page=%E6%97%A5%E6%9C%AC%E3%81%AE%E3%83%80%E3%83%A0%E4%B8%80%E8%A6%A7&format=json&prop=wikitext";
  const listJson = await (await fetch(listUrl)).json();
  const wt = listJson.parse?.wikitext?.["*"] || "";
  if (!wt) throw new Error("dam list wikitext empty");

  // 「堤高順」セクション抽出
  const headIdx = wt.indexOf("=== 堤高順 ===");
  if (headIdx < 0) throw new Error("堤高順 section not found");
  const sectionEnd = wt.indexOf("===", headIdx + 20);
  const section = wt.slice(headIdx, sectionEnd > 0 ? sectionEnd : wt.length);

  // 表の各行から「ダム名」と「高さ」を取得
  // 行の構造: !順位 | 所在地 | 水系 | 河川 | ダム | 型式 | 高さ | ...
  // ダム名は [[XXX ダム]] のリンク (display none を除く)
  const rows = section.split(/^\|-/m);
  const dams = []; // { name, height }
  for (const row of rows) {
    // ダム名: 5列目あたりに [[XXXダム]] のリンク
    const dmatch = row.match(/\[\[([^\]|]*?ダム(?:\s*\([^)]+\))?)(?:\|[^\]]+)?\]\]/);
    // 高さ: |188.0|| や | 156.0|| のような style 後の数値
    const hmatch = row.match(/\|\s*(\d{2,3}(?:\.\d)?)\|/);
    if (!dmatch || !hmatch) continue;
    let name = dmatch[1].replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!/ダム$/.test(name)) continue;
    const height = Number(hmatch[1]);
    if (!isFinite(height) || height < 100) continue;
    if (dams.find(x => x.name === name)) continue;
    dams.push({ name, height });
  }
  console.log(`  [dam] ${dams.length} dams with height >= 100m`);

  // 2. 各ダム記事の wikitext を batch 取得 → 所在地から (pref, muni) 抽出
  const allPairs = [];
  for (let i = 0; i < dams.length; i += 20) {
    const batch = dams.slice(i, i + 20).map(d => d.name);
    const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(batch.join("|"))}&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
    const json = await (await fetch(url)).json();
    const pages = json.query?.pages || [];
    for (const p of pages) {
      const articleText = p.revisions?.[0]?.slots?.main?.content || "";
      // ダム記事は「所在地」「左岸」「右岸」のいずれかに自治体名が入る
      // 各フィールドからリンクを取って結合
      const fields = ["所在地", "左岸", "右岸"];
      const combined = fields
        .map(f => {
          const m = articleText.match(new RegExp(`\\|\\s*${f}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*\\w|\\n\\}\\})`));
          return m ? m[1] : "";
        })
        .join("\n");
      if (combined) {
        // extractMountainLocations と同じロジック (但しブロックを直接処理)
        const pairs = extractLocationPairsFromBlock(combined);
        for (const pair of pairs) allPairs.push([...pair, p.title]);
      }
    }
  }

  // ユニーク化
  const seen = new Set();
  const uniq = [];
  for (const [p, c] of allPairs) {
    const k = `${p}|${c}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push([p, c]);
  }
  console.log(`  [dam] extracted ${allPairs.length} pairs, ${uniq.length} unique muni`);
  await fs.writeFile(path.join(OUT, "dam.json"), JSON.stringify(uniq));
  console.log(`  → wrote dam.json`);
}

// ----- 自衛隊駐屯地・米軍基地 -----
async function fetchMilitaryBases() {
  console.log("[military]");

  // 1. 自衛隊 (status=1)
  const jsdfPages = [
    "陸上自衛隊の駐屯地一覧",
    "海上自衛隊の陸上施設一覧",
    "航空自衛隊の基地一覧"
  ];
  const jsdfPairs = await extractPairsFromListPages(jsdfPages);
  console.log(`  [military] JSDF: ${jsdfPairs.length} pairs`);

  // 2. 米軍 (status=2) — Wikipedia 各記事の Infobox が不安定なので主要基地の (県, 自治体) を手動定義
  // 在日米軍基地・施設の主要な所在自治体 (専用施設および共同使用施設)
  const usPairs = [
    // 北海道
    ["北海道", "千歳市"],       // キャンプ千歳 (一時利用)
    ["北海道", "別海町"],       // 矢臼別演習場
    ["北海道", "厚岸町"],       // 矢臼別演習場
    ["北海道", "浜中町"],       // 矢臼別演習場
    // 東北
    ["青森県", "三沢市"],       // 三沢飛行場
    ["宮城県", "大和町"],       // 王城寺原演習場 (共同)
    ["宮城県", "色麻町"],
    ["宮城県", "大衡村"],
    // 関東
    ["茨城県", "東海村"],       // 池子地区?
    ["東京都", "福生市"],       // 横田基地
    ["東京都", "瑞穂町"],
    ["東京都", "武蔵村山市"],
    ["東京都", "羽村市"],
    ["東京都", "立川市"],
    ["東京都", "昭島市"],
    ["神奈川県", "横須賀市"],   // 横須賀海軍施設
    ["神奈川県", "綾瀬市"],     // 厚木基地
    ["神奈川県", "大和市"],     // 厚木基地
    ["神奈川県", "座間市"],     // キャンプ座間
    ["神奈川県", "相模原市"],   // キャンプ座間 / 相模補給廠
    ["神奈川県", "逗子市"],     // 池子住宅地区
    ["神奈川県", "横浜市"],     // 横浜ノース・ドック
    ["神奈川県", "鎌倉市"],     // 池子地区
    ["埼玉県", "所沢市"],       // 所沢通信基地
    ["埼玉県", "新座市"],       // 大和田通信所
    ["埼玉県", "和光市"],
    ["千葉県", "木更津市"],     // 木更津 (一部共同)
    ["千葉県", "市原市"],
    // 中部
    ["山梨県", "富士吉田市"],   // 北富士演習場
    ["山梨県", "忍野村"],
    ["山梨県", "山中湖村"],
    ["静岡県", "御殿場市"],     // キャンプ富士・東富士演習場
    ["静岡県", "裾野市"],
    ["静岡県", "小山町"],
    // 近畿・中国
    ["京都府", "京丹後市"],     // 経ヶ岬通信所
    ["広島県", "東広島市"],     // 川上弾薬庫
    ["広島県", "呉市"],         // 秋月弾薬庫
    ["広島県", "江田島市"],     // 秋月弾薬庫
    ["山口県", "岩国市"],       // 岩国飛行場
    // 九州
    ["長崎県", "佐世保市"],     // 佐世保基地
    ["長崎県", "西海市"],       // 横瀬貯油所
    ["福岡県", "福岡市"],       // 板付飛行場
    ["大分県", "由布市"],       // 十文字原演習場 (共同)
    ["大分県", "別府市"],
    // 沖縄県 (専用施設の70%が集中)
    ["沖縄県", "国頭村"],       // 北部訓練場
    ["沖縄県", "東村"],         // 北部訓練場
    ["沖縄県", "名護市"],       // キャンプ・シュワブ / ハンセン
    ["沖縄県", "宜野座村"],     // キャンプ・ハンセン
    ["沖縄県", "金武町"],       // キャンプ・ハンセン
    ["沖縄県", "恩納村"],       // キャンプ・ハンセン
    ["沖縄県", "うるま市"],     // キャンプ・コートニー / ホワイトビーチ
    ["沖縄県", "沖縄市"],       // 嘉手納 / フォスター / 弾薬庫
    ["沖縄県", "嘉手納町"],     // 嘉手納飛行場
    ["沖縄県", "北谷町"],       // 嘉手納 / フォスター / キャンプ瑞慶覧
    ["沖縄県", "読谷村"],       // 嘉手納弾薬庫
    ["沖縄県", "北中城村"],     // フォスター / 瑞慶覧
    ["沖縄県", "宜野湾市"],     // 普天間 / フォスター
    ["沖縄県", "浦添市"],       // キャンプ・キンザー (牧港)
    ["沖縄県", "那覇市"],       // 那覇港湾施設
    ["沖縄県", "南風原町"],     // 那覇港湾施設関連
    ["沖縄県", "伊江村"],       // 伊江島補助飛行場
    ["沖縄県", "久米島町"],     // 久米島・鳥島射爆撃場
    ["沖縄県", "渡名喜村"],     // 出砂島射爆撃場
    ["沖縄県", "北大東村"],     // 沖大東島射爆撃場
    ["沖縄県", "本部町"],       // 八重岳通信所
    ["sentinel", "_"]           // 末尾用
  ].filter(([p]) => p !== "sentinel");
  console.log(`  [military] US: ${usPairs.length} pairs (manual list)`);

  // 統合: 同じ自治体に両方ある場合は status=1 (自衛隊) を優先しない — 米軍が先
  // → 重複時は status=3 (両方) にしてもいいが、シンプルに 別 entry で保存し loader 側で処理
  const entries = [];
  const seen = new Map(); // pref|muni → status (1 or 2)
  for (const [p, c] of jsdfPairs) {
    seen.set(`${p}|${c}`, 1);
  }
  // 米軍は後勝ち → 重複自治体は US(シアン) 優先表示 (米軍施設の方が希少で目立たせたい)
  for (const [p, c] of usPairs) {
    seen.set(`${p}|${c}`, 2);
  }
  for (const [k, status] of seen) {
    const [p, c] = k.split("|");
    entries.push([p, c, status]);
  }

  const jsdfCount = entries.filter(e => e[2] === 1).length;
  const usCount = entries.filter(e => e[2] === 2).length;
  console.log(`  [military] total=${entries.length} (JSDF=${jsdfCount}, US-only=${usCount})`);
  await fs.writeFile(path.join(OUT, "military.json"), JSON.stringify(entries));
  console.log(`  → wrote military.json`);
}

// 一覧ページから (pref, muni) ペアを抽出
async function extractPairsFromListPages(titles) {
  const allPairs = [];
  for (const title of titles) {
    const url = `https://ja.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext`;
    const json = await (await fetch(url)).json();
    const wt = json.parse?.wikitext?.["*"] || "";
    if (!wt) continue;
    // 全文に対して: 直前/同一行の 県/府/都/道 リンクを current pref として、
    // 後続の (..[[X市/町/村]]..) を抽出
    const linkRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
    let curPref = null;
    let m;
    while ((m = linkRe.exec(wt))) {
      const baseName = m[1].trim().replace(/\s*\([^)]*\)\s*$/, "");
      if (PREF_SET.has(baseName)) {
        curPref = baseName;
      } else if (/(市|町|村)$/.test(baseName) && curPref) {
        if (/(市|町|村)$/.test(baseName) && !/^新?(.+?市|.+?町|.+?村)$/.test(baseName)) continue;
        // 「中央区」のような特別区はスキップ (DC は親市名でマッチしたい)
        allPairs.push([curPref, baseName]);
      }
    }
  }
  return allPairs;
}

// 個別記事の Infobox 所在地から (pref, muni) を抽出
async function extractPairsFromInfoboxes(titles) {
  const allPairs = [];
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(batch.join("|"))}&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
    const json = await (await fetch(url)).json();
    const pages = json.query?.pages || [];
    for (const p of pages) {
      const articleText = p.revisions?.[0]?.slots?.main?.content || "";
      if (!articleText || p.missing) continue;
      // 「|所在地=」「|位置=」「|住所=」のいずれかのフィールドのみを対象
      // 他フィールドや本文を見ると別県情報が混入するため除外
      const fields = ["所在地", "位置", "住所", "場所", "地区"];
      let combined = "";
      for (const f of fields) {
        const m = articleText.match(new RegExp(`\\|\\s*${f}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*\\w|\\n\\}\\})`));
        if (m) combined += "\n" + m[1];
      }
      if (!combined) {
        console.log(`  [military] no location field in: ${p.title}`);
        continue;
      }
      const pairs = extractLocationPairsFromBlock(combined);
      for (const pair of pairs) allPairs.push(pair);
    }
  }
  return allPairs;
}

// ----- 平成の大合併 (1999-2010 に各自治体が吸収した旧市町村数) -----
async function fetchHeiseiMergers() {
  console.log("[heisei]");
  const prefs = [...PREF_SET];
  const counts = []; // [destPref, destMuni, count]

  for (const pref of prefs) {
    const pageTitle = `${pref}の廃止市町村一覧`;
    const url = `https://ja.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=wikitext&redirects=1`;
    let json;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "japan-stats-map/1.0 (https://github.com/inagakigo/japan-stats-map)" } });
      const txt = await res.text();
      json = JSON.parse(txt);
    } catch (e) {
      console.log(`  [heisei] ${pref}: fetch error ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    const wt = json.parse?.wikitext?.["*"] || "";
    if (!wt) {
      console.log(`  [heisei] ${pref}: 記事なし`);
      continue;
    }
    // セクションヘッダ複数パターン対応: 「2000年-」「2000年～」「2000年代」「2000年以降」など
    let section = "";
    // 「== 1999年〜 ==」「== 2000年〜 ==」「== 2000年代 ==」「== 平成 (大合併) ==」など包括的に
    const headRe = /={2,}\s*((?:199[5-9]|200\d|2010)年\s*[〜～\-－—–~ ]?\s*(?:\d{4}年)?\s*(?:代|以降|以降廃止分|廃止分)?|平成[^=\n]*合併)\s*={2,}/g;
    const headMatches = [...wt.matchAll(headRe)];
    if (headMatches.length > 0) {
      // 最初の Heisei 系見出しから、最後の == の前まで切り出す
      const first = headMatches[0].index;
      // 次の上位レベル == セクション (Heisei 系以外) まで
      const restAfter = wt.slice(first);
      const upperRe = /\n==\s*(?:参考|関連|出典|脚注|外部|備考|総数|附録|統計)[^=\n]*==/;
      const upperMatch = restAfter.match(upperRe);
      section = upperMatch ? restAfter.slice(0, upperMatch.index) : restAfter;
    } else {
      // 年単位細粒度 (=== YYYY年MM月DD日 ===) を全部スキャン
      const yearRe = /={2,}\s*((?:19|20)\d{2})年[\s\d月日～\-]*\s*={2,}/g;
      const matches = [...wt.matchAll(yearRe)];
      for (let i = 0; i < matches.length; i++) {
        const y = Number(matches[i][1]);
        if (y >= 1999 && y <= 2010) {
          const start = matches[i].index;
          const end = (i + 1 < matches.length) ? matches[i + 1].index : wt.length;
          section += wt.slice(start, end) + "\n";
        }
      }
    }
    if (!section) {
      console.log(`  [heisei] ${pref}: Heisei セクション無し`);
      continue;
    }

    // 各 bullet 行から destination muni を抽出
    // パターン1: ）[[XXX市]]新設のため  → XXX市が新設(=その分の旧自治体が吸収)
    // パターン2: ）[[XXX市]]に編入のため / XXX市編入のため
    // パターン3: ）XXX市新設のため (link なし)
    const lines = section.split("\n");
    const muniCount = new Map(); // muniName → count
    const dateRe = /[（(](\d{4})年/;
    for (const line of lines) {
      if (!line.startsWith("*")) continue;
      // 日付チェック: 1999-04-01 〜 2010-03-31 を平成の大合併期間とする
      const dm = line.match(dateRe);
      if (dm) {
        const y = Number(dm[1]);
        if (y < 1999 || y > 2010) continue;
      }
      // destination muni を抽出 — 「[[XXX市/町/村]]」直前にある「）」または「)」、後ろに「新設」「編入」
      // [[XXX市]] [[XXX市|表示]] のどちらも対応
      // destination muni を検出: 「(に|を)?(編入|新設)」の直前にある muni 名を採用。
      // greedy `.*` で最後にマッチさせる
      const dm2 = line.match(/.*?(?:\[\[([^\]|]+?(?:市|町|村))(?:\|[^\]]+)?\]\]|([一-鿿ぁ-んァ-ヶー・]{1,12}?(?:市|町|村)))(?:に|を|の[一部部分]+を|の一部に)?(?:編入|新設)/);
      // ↑ これは依然として最初のマッチになる。複数候補がある場合、編入/新設キーワードに最も近いものを使うため、
      // 全マッチを取って最後を採用する方式に変更
      const allCands = [...line.matchAll(/\[\[([^\]|]+?(?:市|町|村))(?:\|[^\]]+)?\]\]|(?:^|[\s（()）\-－])([一-鿿ぁ-んァ-ヶー・]{1,12}?(?:市|町|村))(?=[\s\-（に編入新設、。\.])/g)];
      const verbMatch = line.match(/(?:編入|新設)/);
      let destPick = null;
      if (verbMatch && allCands.length) {
        const vIdx = verbMatch.index;
        // verb の直前に位置するマッチを採用
        for (let i = allCands.length - 1; i >= 0; i--) {
          if (allCands[i].index < vIdx) { destPick = allCands[i]; break; }
        }
      }
      if (!destPick) continue;
      const destRaw = destPick[1] || destPick[2];
      if (!destRaw) continue;
      // 「旧・XXX」「（旧）XXX」のようなマーカーを除去
      const dest = destRaw.replace(/^旧[・･\.]?\s*/, "").replace(/\s*\([^)]*\)$/, "").trim();
      if (!dest || !/(市|町|村)$/.test(dest)) continue;
      muniCount.set(dest, (muniCount.get(dest) || 0) + 1);
    }
    for (const [muni, n] of muniCount) {
      counts.push([pref, muni, n]);
    }
    console.log(`  [heisei] ${pref}: ${muniCount.size} 自治体が吸収`);
  }

  console.log(`  [heisei] total: ${counts.length} (pref, muni, count) entries`);
  // ソート (大きい順)
  counts.sort((a, b) => b[2] - a[2]);
  console.log(`  [heisei] top 10:`);
  counts.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "heisei.json"), JSON.stringify(counts));
  console.log(`  → wrote heisei.json`);
}

// ----- 空襲被害件数 (Yahoo!JAPAN 戦争アーカイブ) -----
async function fetchAirRaids() {
  console.log("[airraid]");
  // Yahoo の URL スラッグ (各都道府県) — PREF_SET と同順序の英字スラッグ
  const slugs = {
    "北海道":"hokkaido","青森県":"aomori","岩手県":"iwate","宮城県":"miyagi","秋田県":"akita","山形県":"yamagata","福島県":"fukushima",
    "茨城県":"ibaraki","栃木県":"tochigi","群馬県":"gunma","埼玉県":"saitama","千葉県":"chiba","東京都":"tokyo","神奈川県":"kanagawa",
    "新潟県":"niigata","富山県":"toyama","石川県":"ishikawa","福井県":"fukui","山梨県":"yamanashi","長野県":"nagano","岐阜県":"gifu","静岡県":"shizuoka","愛知県":"aichi","三重県":"mie",
    "滋賀県":"shiga","京都府":"kyoto","大阪府":"osaka","兵庫県":"hyogo","奈良県":"nara","和歌山県":"wakayama",
    "鳥取県":"tottori","島根県":"shimane","岡山県":"okayama","広島県":"hiroshima","山口県":"yamaguchi",
    "徳島県":"tokushima","香川県":"kagawa","愛媛県":"ehime","高知県":"kochi",
    "福岡県":"fukuoka","佐賀県":"saga","長崎県":"nagasaki","熊本県":"kumamoto","大分県":"oita","宮崎県":"miyazaki","鹿児島県":"kagoshima","沖縄県":"okinawa"
  };

  const entries = []; // [pref, muni, count]
  for (const [pref, slug] of Object.entries(slugs)) {
    const url = `https://wararchive.yahoo.co.jp/airraid/${slug}/`;
    let html;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" } });
      if (!res.ok) { console.log(`  [airraid] ${pref}: HTTP ${res.status}`); continue; }
      html = await res.text();
    } catch (e) {
      console.log(`  [airraid] ${pref}: fetch error ${e.message}`);
      continue;
    }
    // 「<li class="airraidAreaInfo_area」で split し、各区間を 1 自治体ブロックとして扱う
    const chunks = html.split(/<li class="airraidAreaInfo_area/);
    let totalForPref = 0;
    let muniCount = 0;
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      // 次の airraidAreaInfo_area が来る前 (もしくは </ul>) までを有効範囲とする
      // chunk は既にそれより前で split されているのでそのまま使ってもよい
      const nameM = chunk.match(/<span class="airraidAreaInfo_header_name">([^<]+)<\/span>/);
      if (!nameM) continue;
      const muni = nameM[1].trim();
      // この自治体ブロックの「次の area までの範囲」(= chunk 全体) に含まれる
      // airraidDateInfo_main_date の数を空襲記録件数として数える
      const count = (chunk.match(/airraidDateInfo_main_date/g) || []).length;
      if (count > 0) {
        entries.push([pref, muni, count]);
        totalForPref += count;
        muniCount++;
      }
    }
    console.log(`  [airraid] ${pref}: ${muniCount} 自治体 / 記録 ${totalForPref} 件`);
  }
  console.log(`  [airraid] total ${entries.length} (pref,muni,count) entries`);
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [airraid] top 10:`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "airraid.json"), JSON.stringify(entries));
  console.log(`  → wrote airraid.json`);
}

// 市町村名 → 所属都道府県 のマップ (cities.topojson から構築)
let _muniToPref = null;
async function getMuniToPref() {
  if (_muniToPref) return _muniToPref;
  const txt = await fs.readFile(path.join(OUT, "cities.topojson"), "utf8");
  const topo = JSON.parse(txt);
  const objKey = Object.keys(topo.objects)[0];
  const geoms = topo.objects[objKey].geometries || [];
  _muniToPref = new Map(); // muniName → Set<prefName>
  for (const g of geoms) {
    const props = g.properties || {};
    const pref = props.N03_001;
    const muni = props.N03_004;
    if (!pref || !muni) continue;
    if (!_muniToPref.has(muni)) _muniToPref.set(muni, new Set());
    _muniToPref.get(muni).add(pref);
  }
  console.log(`  [muniToPref] built: ${_muniToPref.size} muni names`);
  return _muniToPref;
}

// ----- 国立公園 -----
async function fetchNationalParks() {
  console.log("[park]");
  const muniToPref = await getMuniToPref();
  // カテゴリ「日本の国立公園」のページを取得
  const catUrl = "https://ja.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:%E6%97%A5%E6%9C%AC%E3%81%AE%E5%9B%BD%E7%AB%8B%E5%85%AC%E5%9C%92&cmlimit=200&cmtype=page&format=json";
  const catJson = await (await fetch(catUrl)).json();
  const members = (catJson.query?.categorymembers || [])
    .map(x => x.title)
    .filter(t => /国立公園$/.test(t));  // 「日本の国立公園」「Template:...」「海域公園」を除外
  console.log(`  [park] ${members.length} park articles`);

  const allPairs = [];
  for (let i = 0; i < members.length; i += 15) {
    const batch = members.slice(i, i + 15);
    const url = `https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(batch.join("|"))}&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
    const json = await (await fetch(url)).json();
    const pages = json.query?.pages || [];
    for (const p of pages) {
      const wt = p.revisions?.[0]?.slots?.main?.content || "";
      if (!wt) continue;

      // (1) Infobox 「地域」から、この公園がまたがる都道府県のセットを取得
      let regionBlock = "";
      for (const f of ["地域", "所在地", "位置"]) {
        const m = wt.match(new RegExp(`\\|\\s*${f}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*\\w|\\n\\}\\})`));
        if (m) regionBlock += "\n" + m[1];
      }
      const parkPrefs = new Set();
      const prefLinkRe = /\[\[([^\]|]+?(?:都|道|府|県))(?:\|[^\]]+)?\]\]/g;
      let pm;
      while ((pm = prefLinkRe.exec(regionBlock))) {
        const name = pm[1].trim().replace(/\s*\([^)]*\)\s*$/, "");
        if (PREF_SET.has(name)) parkPrefs.add(name);
      }
      // 県リンクが取れない場合(北海道の振興局表記など): 地域フィールド内の muni 候補から県を推定
      if (parkPrefs.size === 0) {
        const muniLinkRe0 = /\[\[([^\]|]+?(?:市|町|村))(?:\|[^\]]+)?\]\]/g;
        let mm0;
        while ((mm0 = muniLinkRe0.exec(regionBlock))) {
          const name = mm0[1].trim().replace(/\s*\([^)]*\)\s*$/, "");
          const candPrefs = muniToPref.get(name);
          if (!candPrefs) continue;
          for (const pr of candPrefs) parkPrefs.add(pr);
        }
      }
      if (parkPrefs.size === 0) {
        console.log(`  [park] ${p.title}: 県セット取れず → スキップ`);
        continue;
      }

      // (2) 「事務所所在地」フィールドのテキストを除外した本文を作る
      // 事務所所在地は通常 Infobox 内なので、その field block だけ除外
      let cleanedWt = wt.replace(/\|\s*事務所所在地\s*=\s*[\s\S]*?(?=\n\s*\|\s*\w|\n\}\})/g, "");

      // (3) 本文全体から [[市町村]] リンクを収集し、parkPrefs に属するものだけ採用
      const muniLinkRe = /\[\[([^\]|]+?(?:市|町|村))(?:\|[^\]]+)?\]\]/g;
      let mm;
      const seen = new Set();
      while ((mm = muniLinkRe.exec(cleanedWt))) {
        const name = mm[1].trim().replace(/\s*\([^)]*\)\s*$/, "");
        if (!/(市|町|村)$/.test(name)) continue;
        const candidatePrefs = muniToPref.get(name);
        if (!candidatePrefs) continue;
        // この自治体が属しうる県が parkPrefs と重なるかチェック
        for (const pr of candidatePrefs) {
          if (parkPrefs.has(pr)) {
            const k = `${pr}|${name}`;
            if (seen.has(k)) continue;
            seen.add(k);
            allPairs.push([pr, name, p.title]);
          }
        }
      }
    }
  }

  // ユニーク化 (pref|muni)
  const seen = new Set();
  const uniq = [];
  for (const [pr, c] of allPairs) {
    const k = `${pr}|${c}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push([pr, c]);
  }
  console.log(`  [park] extracted ${allPairs.length} pairs, ${uniq.length} unique muni`);
  await fs.writeFile(path.join(OUT, "park.json"), JSON.stringify(uniq));
  console.log(`  → wrote park.json`);
}

// 各都道府県の自治体名リスト (cities.topojson から構築、N03_004 ベース)
// 政令市の親市名 (横浜市など) も含む
async function getMunisByPref() {
  const txt = await fs.readFile(path.join(OUT, "cities.topojson"), "utf8");
  const topo = JSON.parse(txt);
  const objKey = Object.keys(topo.objects)[0];
  const geoms = topo.objects[objKey].geometries || [];
  const byPref = new Map(); // pref → Set<muni name>
  const dcSet = new Set(["札幌市","仙台市","さいたま市","千葉市","横浜市","川崎市","相模原市","新潟市","静岡市","浜松市","名古屋市","京都市","大阪市","堺市","神戸市","岡山市","広島市","北九州市","福岡市","熊本市"]);
  for (const g of geoms) {
    const props = g.properties || {};
    const pref = props.N03_001, muni = props.N03_004, parent = props.N03_003;
    if (!pref || !muni) continue;
    if (!byPref.has(pref)) byPref.set(pref, new Set());
    byPref.get(pref).add(muni);
    if (parent && dcSet.has(parent)) byPref.get(pref).add(parent);
  }
  // 長い名前順にソート (最長マッチ用)
  const sorted = new Map();
  for (const [p, set] of byPref) {
    sorted.set(p, [...set].sort((a, b) => b.length - a.length));
  }
  return sorted;
}

// ----- 餃子の王将 (店舗数/自治体) -----
async function fetchOhsho() {
  console.log("[ohsho]");
  const munisByPref = await getMunisByPref();
  // 各都道府県の URL は緯度経度パラメータ付き — 王将トップページから抽出
  const indexHtml = await (await fetch("https://www.ohsho.co.jp/shop/", {
    headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" }
  })).text();
  // <a href="https://map.ohsho.co.jp/b/ohsho/?t=prefectures&...">県名</a>
  const prefLinks = [...indexHtml.matchAll(/href="(https:\/\/map\.ohsho\.co\.jp\/b\/ohsho\/\?t=prefectures&[^"]+)">([^<]+)<\/a>/g)];
  console.log(`  [ohsho] ${prefLinks.length} pref links`);

  // 自治体ごとの店舗数を集計
  const counts = new Map(); // "pref|muni" → count
  for (const [, url, prefName] of prefLinks) {
    const cleanPref = prefName.trim();
    if (!PREF_SET.has(cleanPref)) continue;
    let html;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" } });
      html = await res.text();
    } catch (e) {
      console.log(`  [ohsho] ${cleanPref}: fetch error`);
      continue;
    }
    // 住所抽出: 〒XXX-XXXX 都道府県... のパターン
    // pref 名のすぐ後に 市/区(独立)/町/村 が来る
    // ・政令市: 「横浜市鶴見区」 → muni = 鶴見区
    // ・通常市: 「厚木市」 → muni = 厚木市
    // ・郡部町村: 「足柄上郡松田町」 → muni = 松田町
    const prefMunis = munisByPref.get(cleanPref) || [];
    // 住所先頭: 「〒XXX-XXXX 大阪府大阪市福島区野田4-...」「神奈川県厚木市本厚木...」など。
    // pref 名直後の地名部分(漢字/かな のみ)を捕捉
    const addrRe = new RegExp(`〒\\d{3}-?\\d{4}[\\s　]*${cleanPref}([\\u3000-\\u9faf々ヵヶ・ー]+)`, "g");
    let shopsInPref = 0;
    let m;
    while ((m = addrRe.exec(html))) {
      const after = m[1]; // pref 名以降の地名
      // 政令市親 + 区: 「横浜市鶴見区」など先に試す
      // for each muni in prefMunis (longest first), check if `after` startsWith it
      // — DC ward の場合 親市+区 が含まれるので、まず親市マッチを試し、次に区を取る
      let muni = null;
      // step 1: 政令市の親市名 (横浜市 etc.) で startsWith かチェック → 直後の 「XX区」 を muni に
      const dcRe = /^(札幌市|仙台市|さいたま市|千葉市|横浜市|川崎市|相模原市|新潟市|静岡市|浜松市|名古屋市|京都市|大阪市|堺市|神戸市|岡山市|広島市|北九州市|福岡市|熊本市)(.+?区)/;
      const dcMatch = after.match(dcRe);
      if (dcMatch) {
        muni = dcMatch[2];
      } else {
        // step 2: pref のあらゆる muni 名で最長マッチ
        // ただし「四日市市」のように 市/町/村 が複数連続する名前も正しく取れるよう、known list で検索
        for (const candidate of prefMunis) {
          if (after.startsWith(candidate)) { muni = candidate; break; }
        }
        // step 3: 郡部の「○○郡XX町」フォールバック (topojson に未収録のケース)
        if (!muni) {
          const gunMatch = after.match(/^.+?郡(.+?(?:町|村))/);
          if (gunMatch) muni = gunMatch[1];
        }
      }
      if (!muni) continue;
      const key = `${cleanPref}|${muni}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      shopsInPref++;
    }
    console.log(`  [ohsho] ${cleanPref}: ${shopsInPref} 店`);
  }

  const entries = [];
  for (const [key, count] of counts) {
    const [pref, muni] = key.split("|");
    entries.push([pref, muni, count]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [ohsho] total: ${entries.length} (pref,muni,count) entries`);
  console.log(`  [ohsho] top 10:`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "ohsho.json"), JSON.stringify(entries));
  console.log(`  → wrote ohsho.json`);
}

// ----- ラーメン山岡家 -----
async function fetchYamaokaya() {
  console.log("[yamaokaya]");
  const munisByPref = await getMunisByPref();

  // 1. メインの店舗一覧から shop ID と所属 pref を取得
  const idxHtml = await (await fetch("https://www.yamaokaya.com/shops/", {
    headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" }
  })).text();

  // 県セクションは h3 で区切られる (h2 はリージョン)
  // 形式: <h3 class="shops_part_tit"><strong>東北</strong>岩手県 全域</h3>
  //   または <h3 class="shops_part_tit"><strong>北海道</strong>道東エリア</h3>
  const sections = idxHtml.split(/<h3[^>]*class="shops_part_tit"[^>]*>([\s\S]*?)<\/h3>/);
  const shopIds = []; // { id, pref }
  for (let i = 1; i < sections.length; i += 2) {
    const headInner = sections[i];
    // <strong>region</strong>残り
    const strongM = headInner.match(/<strong>([^<]+)<\/strong>([\s\S]+)/);
    let region = "", tail = "";
    if (strongM) { region = strongM[1].trim(); tail = strongM[2].trim(); }
    else tail = headInner.trim();
    // region が「北海道」なら pref = 北海道。それ以外は tail の先頭から pref を抽出
    let pref = null;
    if (region === "北海道") {
      pref = "北海道";
    } else {
      // tail の先頭から都/道/府/県 名を抽出
      const pm = tail.match(/^([^\s　]+?(?:都|道|府|県))/);
      if (pm && PREF_SET.has(pm[1])) pref = pm[1];
    }
    if (!pref) continue;
    const body = sections[i + 1] || "";
    const ids = [...body.matchAll(/id="s(\d{3,5})"/g)].map(m => m[1]);
    for (const id of ids) shopIds.push({ id, pref });
  }
  console.log(`  [yamaokaya] ${shopIds.length} shops indexed`);

  // 2. 各 shop ページから住所を取得
  const counts = new Map(); // "pref|muni" → count
  let processed = 0;
  for (const { id, pref } of shopIds) {
    try {
      const html = await (await fetch(`https://www.yamaokaya.com/shops/${id}/`, {
        headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" }
      })).text();
      // 住所: 「住所</th> <td...> 〒 NNN-NNNN<br> 県名+市町村+...」
      // 県名は省略されてる場合あり (北見市光西町165 など)
      const m = html.match(/住所[\s\S]{0,200}?〒\s*\d{3}-?\d{4}<br>\s*([^\n<]+?)</);
      if (!m) { processed++; continue; }
      let addr = m[1].trim();
      // 県名で始まる場合は除去
      if (addr.startsWith(pref)) addr = addr.slice(pref.length);
      // 政令市の区 + その他 = 最長マッチ
      const prefMunis = munisByPref.get(pref) || [];
      let muni = null;
      const dcRe = /^(札幌市|仙台市|さいたま市|千葉市|横浜市|川崎市|相模原市|新潟市|静岡市|浜松市|名古屋市|京都市|大阪市|堺市|神戸市|岡山市|広島市|北九州市|福岡市|熊本市)(.+?区)/;
      const dcMatch = addr.match(dcRe);
      if (dcMatch) {
        muni = dcMatch[2];
      } else {
        for (const candidate of prefMunis) {
          if (addr.startsWith(candidate)) { muni = candidate; break; }
        }
        if (!muni) {
          const gunMatch = addr.match(/^.+?郡(.+?(?:町|村))/);
          if (gunMatch) muni = gunMatch[1];
        }
      }
      if (!muni) {
        if (processed < 5) console.log(`  [yamaokaya] muni 不明: ${pref} | ${addr.slice(0,30)}`);
      } else {
        const key = `${pref}|${muni}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    } catch (e) {
      console.log(`  [yamaokaya] shop ${id} fetch error: ${e.message}`);
    }
    processed++;
    if (processed % 50 === 0) console.log(`  [yamaokaya] ${processed}/${shopIds.length} processed`);
  }

  const entries = [];
  for (const [key, count] of counts) {
    const [pref, muni] = key.split("|");
    entries.push([pref, muni, count]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [yamaokaya] total: ${entries.length} (pref,muni,count) entries`);
  console.log(`  [yamaokaya] top 10:`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "yamaokaya.json"), JSON.stringify(entries));
  console.log(`  → wrote yamaokaya.json`);
}

// ----- ラーメンショップ (rasho-db.com 集約) -----
async function fetchRamenShop() {
  console.log("[rasho]");
  const munisByPref = await getMunisByPref();

  // sitemap から店舗 URL を取得
  const smXml = await (await fetch("https://rasho-db.com/post-sitemap.xml", {
    headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" }
  })).text();
  const shopUrls = [...smXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(u => !u.includes("-list") && !u.includes("jin-test") && !u.includes("contact") && /rasho-db\.com\/[^/]+\/[^/]+\/?$/.test(u));
  console.log(`  [rasho] ${shopUrls.length} shop URLs`);

  const counts = new Map(); // "pref|muni" → count
  let processed = 0;
  for (const url of shopUrls) {
    try {
      const html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" } })).text();
      // pref + 続く地名部分(漢字かなのみ)を捕捉
      const m = html.match(/([一-龯]{2,4}(?:都|道|府|県))([一-龯々ヵヶ・ー]+)/);
      if (!m) { processed++; continue; }
      const pref = m[1];
      const after = m[2];
      const prefMunis = munisByPref.get(pref) || [];
      let muni = null;
      // 政令市の区 「○○市XX区」
      const dcRe = /^(札幌市|仙台市|さいたま市|千葉市|横浜市|川崎市|相模原市|新潟市|静岡市|浜松市|名古屋市|京都市|大阪市|堺市|神戸市|岡山市|広島市|北九州市|福岡市|熊本市)(.+?区)/;
      const dcMatch = after.match(dcRe);
      if (dcMatch) muni = dcMatch[2];
      else {
        // pref のあらゆる muni 名で最長マッチ
        for (const candidate of prefMunis) {
          if (after.startsWith(candidate)) { muni = candidate; break; }
        }
        if (!muni) {
          const gunMatch = after.match(/^.+?郡(.+?(?:町|村))/);
          if (gunMatch) muni = gunMatch[1];
        }
      }
      if (!muni) { processed++; continue; }
      const key = `${pref}|${muni}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    } catch (e) {
      console.log(`  [rasho] ${url}: ${e.message}`);
    }
    processed++;
  }

  const entries = [];
  for (const [key, count] of counts) {
    const [pref, muni] = key.split("|");
    entries.push([pref, muni, count]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [rasho] total: ${entries.length} entries`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "rasho.json"), JSON.stringify(entries));
  console.log(`  → wrote rasho.json`);
}

// ----- 焼き物 (yakimono-plaza.com) -----
async function fetchYakimono() {
  console.log("[yakimono]");
  const munisByPref = await getMunisByPref();
  const html = await (await fetch("https://www.yakimono-plaza.com/data/data1/", {
    headers: { "User-Agent": "Mozilla/5.0 japan-stats-map/1.0" }
  })).text();
  // <tr ...> ... <td class="column-1">..県名<br /> 市町村名</td> ... </tr>
  const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<td class="column-1">([\s\S]*?)<\/td>/g)];
  console.log(`  [yakimono] ${rows.length} rows`);

  const counts = new Map(); // "pref|muni" → count
  let missCount = 0;
  for (const r of rows) {
    const cell = r[1].replace(/<span[^>]*>[\s\S]*?<\/span>/g, "");
    // 「北海道<br /> 函館市」「東京都<br /> 千代田区」など
    const m = cell.match(/([一-龯]{2,4}(?:都|道|府|県))[\s\S]*?<br\s*\/?>\s*([一-龯々ヵヶ・ー]+)/);
    if (!m) { missCount++; continue; }
    const pref = m[1];
    const muniRaw = m[2].trim();
    if (!PREF_SET.has(pref)) { missCount++; continue; }
    const prefMunis = munisByPref.get(pref) || [];
    let muni = null;
    // 政令市の区
    const dcRe = /^(札幌市|仙台市|さいたま市|千葉市|横浜市|川崎市|相模原市|新潟市|静岡市|浜松市|名古屋市|京都市|大阪市|堺市|神戸市|岡山市|広島市|北九州市|福岡市|熊本市)(.+?区)/;
    const dcMatch = muniRaw.match(dcRe);
    if (dcMatch) muni = dcMatch[2];
    else {
      for (const cand of prefMunis) {
        if (muniRaw.startsWith(cand)) { muni = cand; break; }
      }
      if (!muni) {
        const gunMatch = muniRaw.match(/^.+?郡(.+?(?:町|村))/);
        if (gunMatch) muni = gunMatch[1];
      }
    }
    if (!muni) { missCount++; continue; }
    const key = `${pref}|${muni}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const entries = [];
  for (const [key, count] of counts) {
    const [pref, muni] = key.split("|");
    entries.push([pref, muni, count]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [yakimono] miss=${missCount}, total ${entries.length} (pref,muni,count)`);
  console.log(`  [yakimono] top 10:`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "yakimono.json"), JSON.stringify(entries));
  console.log(`  → wrote yakimono.json`);
}

// ----- 空港 (Wikipedia「日本の空港」地域一覧より) -----
async function fetchAirports() {
  console.log("[airport]");
  const url = "https://ja.wikipedia.org/w/api.php?action=parse&page=%E6%97%A5%E6%9C%AC%E3%81%AE%E7%A9%BA%E6%B8%AF&format=json&prop=wikitext";
  const json = await (await fetch(url)).json();
  const wt = json.parse?.wikitext?.["*"] || "";
  if (!wt) throw new Error("airport wikitext empty");

  // 「== 地域一覧 ==」から次の level-2 セクションまで切り出し
  const start = wt.search(/==\s*地域一覧\s*==/);
  // \n== name == の形式 (level 2 のみ — level 3 は === なので回避)
  const restAfter = wt.slice(start + 20);
  const nextMatch = restAfter.search(/\n==[^=][^\n]*==[^=]/);
  const end = nextMatch >= 0 ? start + 20 + nextMatch : wt.length;
  const section = wt.slice(start, end);

  // 各 bullet 行から 〔...〕 を抽出
  // 北海道地方セクションでは pref が省略され muni のみ
  const lines = section.split("\n");
  let curRegionPref = null;
  const pairs = []; // [pref, muni]
  const seen = new Set();
  for (const line of lines) {
    const sec = line.match(/^={2,}\s*([^=]+?)\s*={2,}/);
    if (sec) {
      // 「北海道地方」→ pref=北海道 とする (region pref として保持)
      const reg = sec[1].trim();
      if (reg === "北海道地方") curRegionPref = "北海道";
      else curRegionPref = null;
      continue;
    }
    if (!line.startsWith("*")) continue;
    // 〔...〕 を抽出
    const br = line.match(/〔([^〕]+)〕/);
    if (!br) continue;
    const content = br[1];
    // 中の [[links]] を全取得
    const links = [...content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
    if (!links.length) continue;
    // 先頭が県なら基準にする
    let pref = curRegionPref;
    let muniLinks = [...links];
    if (PREF_SET.has(links[0])) {
      pref = links[0];
      muniLinks = links.slice(1);
    }
    if (!pref) continue;
    let currentPref = pref;
    for (const l of muniLinks) {
      const clean = l.replace(/\s*\([^)]*\)\s*$/, "");
      if (PREF_SET.has(clean)) {
        // 途中で別の県名が出てきた場合 (複数県にまたがる空港) → pref を切替
        currentPref = clean;
        continue;
      }
      // 郡名はスキップ
      if (/郡$/.test(clean)) continue;
      // 市/町/村/区 のいずれか
      if (!/(市|町|村|区)$/.test(clean)) continue;
      const k = `${currentPref}|${clean}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push([currentPref, clean, 1]);
    }
  }
  console.log(`  [airport] ${pairs.length} (pref,muni) entries`);
  pairs.slice(0, 15).forEach(([p, m]) => console.log(`    ${p} ${m}`));
  await fs.writeFile(path.join(OUT, "airport.json"), JSON.stringify(pairs));
  console.log(`  → wrote airport.json`);
}

// ----- 日本酒の蔵元 (各蔵元記事の所在地から自治体カウント) -----
async function fetchSake() {
  console.log("[sake]");
  const munisByPref = await getMunisByPref();
  const UA = "japan-stats-map/1.0 (https://github.com/inagakigo/japan-stats-map)";
  const url = "https://ja.wikipedia.org/w/api.php?action=parse&page=%E6%97%A5%E6%9C%AC%E9%85%92%E3%83%A1%E3%83%BC%E3%82%AB%E3%83%BC%E4%B8%80%E8%A6%A7&format=json&prop=wikitext";
  const json = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  const wt = json.parse?.wikitext?.["*"] || "";

  // 各 bullet 行から「[[記事名]]」リンクを抽出
  const titles = [];
  for (const line of wt.split("\n")) {
    if (!/^\*\s*\[/.test(line)) continue;
    // 最初の [[link]] を採用 (社名のリンクが先頭)
    const m = line.match(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/);
    if (m) titles.push(m[1].trim());
  }
  console.log(`  [sake] ${titles.length} brewery article titles`);

  // 各記事を batch fetch → 本社所在地/所在地 から (pref, muni) 抽出
  const counts = new Map(); // "pref|muni" → count
  for (let i = 0; i < titles.length; i += 30) {
    const batch = titles.slice(i, i + 30);
    const u = `https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(batch.join("|"))}&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
    let j;
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA } });
      const txt = await res.text();
      j = JSON.parse(txt);
    } catch (e) {
      console.log(`  [sake] batch ${i}: ${e.message} — 2s wait & retry`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch(u, { headers: { "User-Agent": UA } });
        j = JSON.parse(await res.text());
      } catch (e2) { console.log(`  [sake] batch ${i}: retry failed`); continue; }
    }
    const pages = j.query?.pages || [];
    if (i % 90 === 60) await new Promise(r => setTimeout(r, 500));
    for (const p of pages) {
      const w = p.revisions?.[0]?.slots?.main?.content || "";
      if (!w || p.missing) continue;
      // フィールド優先順: 本社所在地 > 所在地 > 本店所在地
      let block = "";
      for (const f of ["本社所在地", "所在地", "本店所在地"]) {
        const re = new RegExp(`\\|\\s*${f}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*\\w|\\n\\}\\})`);
        const mm = w.match(re);
        if (mm && mm[1].trim()) { block = mm[1]; break; }
      }
      if (!block) continue;
      // pref + muni 抽出
      const prefM = block.match(/\[\[([^\]|]+?(?:都|道|府|県))(?:\|[^\]]+)?\]\]/);
      if (!prefM) continue;
      const pref = prefM[1];
      if (!PREF_SET.has(pref)) continue;
      // pref 以降の文字列から muni を見つける
      const afterIdx = block.indexOf(prefM[0]) + prefM[0].length;
      const after = block.slice(afterIdx, afterIdx + 200);
      const prefMunis = munisByPref.get(pref) || [];
      let muni = null;
      // 政令市の区
      const dcRe = /\[\[(札幌市|仙台市|さいたま市|千葉市|横浜市|川崎市|相模原市|新潟市|静岡市|浜松市|名古屋市|京都市|大阪市|堺市|神戸市|岡山市|広島市|北九州市|福岡市|熊本市)\]\]\[\[(?:[^\]|]+?\|)?([^\]|]+?区)\]\]/;
      const dcM = after.match(dcRe);
      if (dcM) muni = dcM[2];
      else {
        // 通常 muni リンク
        const muniM = after.match(/\[\[([^\]|]+?(?:市|町|村))(?:\|[^\]]+)?\]\]/);
        if (muniM) {
          const candidate = muniM[1].replace(/\s*\([^)]*\)\s*$/, "");
          // pref の自治体リストに含まれるか確認
          if (prefMunis.includes(candidate)) muni = candidate;
        }
      }
      if (!muni) continue;
      const key = `${pref}|${muni}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const entries = [];
  for (const [k, c] of counts) {
    const [pref, muni] = k.split("|");
    entries.push([pref, muni, c]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [sake] ${entries.length} muni entries with breweries`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "sake.json"), JSON.stringify(entries));
  console.log(`  → wrote sake.json`);
}

// ----- ブランド牛 (Wikipedia「日本のブランド牛一覧」より県別カウント) -----
// 県単位の指標なので、その県に属する全自治体に同じ値を割当 (popMap の pref 2 桁 fallback を利用)
async function fetchBrandBeef() {
  console.log("[brandbeef]");
  const munisByPref = await getMunisByPref();
  const UA = "japan-stats-map/1.0 (https://github.com/inagakigo/japan-stats-map)";
  const url = "https://ja.wikipedia.org/w/api.php?action=parse&page=%E6%97%A5%E6%9C%AC%E3%81%AE%E3%83%96%E3%83%A9%E3%83%B3%E3%83%89%E7%89%9B%E4%B8%80%E8%A6%A7&format=json&prop=wikitext";
  const json = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  const wt = json.parse?.wikitext?.["*"] || "";
  if (!wt) throw new Error("brandbeef wikitext empty");

  // 全 bullet 行から [[銘柄名]] を抽出
  const titles = [];
  for (const line of wt.split("\n")) {
    if (!/^\*\s*\[/.test(line)) continue;
    const m = line.match(/^\*\s*\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/);
    if (m) titles.push(m[1].trim());
  }
  console.log(`  [brandbeef] ${titles.length} brand article titles`);

  // DC 親市リスト
  const DC = ["札幌市","仙台市","さいたま市","千葉市","横浜市","川崎市","相模原市","新潟市","静岡市","浜松市","名古屋市","京都市","大阪市","堺市","神戸市","岡山市","広島市","北九州市","福岡市","熊本市"];

  // 各記事の本文冒頭から「[[県]][[市/町/村]]」パターンを取って 1 銘柄=1 muni でカウント
  const counts = new Map();
  for (let i = 0; i < titles.length; i += 30) {
    const batch = titles.slice(i, i + 30);
    const u = `https://ja.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(batch.join("|"))}&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
    let j;
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA } });
      j = JSON.parse(await res.text());
    } catch (e) {
      console.log(`  [brandbeef] batch ${i}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    const pages = j.query?.pages || [];
    for (const p of pages) {
      const w = p.revisions?.[0]?.slots?.main?.content || "";
      if (!w || p.missing) continue;
      const intro = w.slice(0, 3000);
      const brandTitle = p.title; // 例: 米沢牛, 松阪牛, 神戸ビーフ
      // ステップ1: [[県]][[市/町/村]] パターン
      const re = /\[\[([^\]|]+?(?:都|道|府|県))(?:\|[^\]]+)?\]\]\s*(?:\[\[[^\]|]+?郡(?:\|[^\]]+)?\]\])?\s*\[\[([^\]|]+?(?:市|町|村))(?:\|[^\]]+)?\]\]/g;
      let pm;
      let found = false;
      while (!found && (pm = re.exec(intro))) {
        const pref = pm[1].replace(/\s*\([^)]*\)\s*$/, "");
        const muniRaw = pm[2].replace(/\s*\([^)]*\)\s*$/, "");
        if (!PREF_SET.has(pref)) continue;
        const prefMunis = munisByPref.get(pref) || [];
        let muni = muniRaw;
        if (DC.includes(muniRaw)) {
          const wardAfter = intro.slice(pm.index + pm[0].length, pm.index + pm[0].length + 60);
          const wm = wardAfter.match(/^\s*\[\[(?:[^\]|]+?\|)?([^\]|]+?区)\]\]/);
          if (wm) muni = wm[1];
        }
        if (!prefMunis.includes(muni)) continue;
        counts.set(`${pref}|${muni}`, (counts.get(`${pref}|${muni}`) || 0) + 1);
        found = true;
      }
      if (found) continue;

      // ステップ2: 銘柄名から muni 推測。最初に見つかった県の muni リストから、銘柄名に含まれる muni を探す
      const prefM = intro.match(/\[\[([^\]|]+?(?:都|道|府|県))(?:\|[^\]]+)?\]\]/);
      if (!prefM) continue;
      const pref = prefM[1].replace(/\s*\([^)]*\)\s*$/, "");
      if (!PREF_SET.has(pref)) continue;
      const prefMunis = munisByPref.get(pref) || [];
      // 銘柄名から「XX牛」「XXビーフ」を切り取った地名部分
      const brandStem = brandTitle.replace(/(牛|ビーフ|和牛|黒毛|あか牛|赤牛|短角牛)$/g, "").replace(/^(特産|くまもと)/, "");
      // brandStem を含む muni を探す (最長マッチ)
      let bestMuni = null;
      for (const cand of [...prefMunis].sort((a, b) => b.length - a.length)) {
        const candStem = cand.replace(/(市|町|村|区)$/, "");
        if (brandStem.includes(candStem) || candStem.includes(brandStem)) {
          bestMuni = cand;
          break;
        }
      }
      if (bestMuni) {
        counts.set(`${pref}|${bestMuni}`, (counts.get(`${pref}|${bestMuni}`) || 0) + 1);
      }
    }
  }

  const entries = [];
  for (const [k, c] of counts) {
    const [pref, muni] = k.split("|");
    entries.push([pref, muni, c]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [brandbeef] ${entries.length} muni entries`);
  entries.slice(0, 10).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "brandbeef.json"), JSON.stringify(entries));
  console.log(`  → wrote brandbeef.json`);
}

// ----- プロ野球選手 (Wikidata の野球選手で日本国籍 + 出生地から自治体カウント) -----
async function fetchBaseball() {
  console.log("[baseball]");
  const munisByPref = await getMunisByPref();
  const UA = "japan-stats-map/1.0 (https://github.com/inagakigo/japan-stats-map)";

  const query = `
    SELECT ?p ?pLabel ?bpLabel ?adminLabel WHERE {
      ?p wdt:P106 wd:Q10871364 .
      ?p wdt:P27 wd:Q17 .
      ?p wdt:P19 ?bp .
      OPTIONAL { ?bp wdt:P131* ?admin . ?admin wdt:P31 wd:Q50337 . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en". }
    }
  `;
  const sparqlUrl = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query);
  const res = await fetch(sparqlUrl, { headers: { "User-Agent": UA, "Accept": "application/sparql-results+json" } });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
  const data = await res.json();
  const bindings = data.results?.bindings || [];
  console.log(`  [baseball] ${bindings.length} player records`);

  const DC = new Set(["札幌市","仙台市","さいたま市","千葉市","横浜市","川崎市","相模原市","新潟市","静岡市","浜松市","名古屋市","京都市","大阪市","堺市","神戸市","岡山市","広島市","北九州市","福岡市","熊本市"]);
  const counts = new Map(); // "pref|muni" → count
  const playerSeen = new Set(); // 同一人物の重複防止
  let prefOnlyCount = 0, matched = 0;
  for (const b of bindings) {
    const pid = b.p?.value || "";
    if (playerSeen.has(pid)) continue;
    playerSeen.add(pid);
    const bp = (b.bpLabel?.value || "").trim();
    const pref = (b.adminLabel?.value || "").trim();
    if (!PREF_SET.has(pref)) continue;
    // bp が県名と一致 → 出生地が県レベルしかない → スキップ
    if (bp === pref) { prefOnlyCount++; continue; }
    const prefMunis = munisByPref.get(pref) || [];
    // bp が市町村名そのものなら直接マッチ
    let muni = null;
    if (prefMunis.includes(bp)) {
      muni = bp;
    } else if (DC.has(bp)) {
      // 政令市親市 (bp="横浜市" など) → muni はそのまま (全区扱い)
      muni = bp;
    } else if (/区$/.test(bp)) {
      // ward only (戸塚区 など) → 県内で一致する ward を探す
      const wardMatches = prefMunis.filter(m => m === bp);
      if (wardMatches.length === 1) muni = wardMatches[0];
      else if (wardMatches.length > 1) muni = wardMatches[0]; // 複数候補は最初
    } else {
      // bp に「市町村」を含む場合 (「横浜市戸塚区」とか) → 末尾の muni を抽出
      const w = bp.match(/[^市区町村]+(?:市|町|村|区)$/);
      if (w && prefMunis.includes(w[0])) muni = w[0];
    }
    if (!muni) continue;
    const key = `${pref}|${muni}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    matched++;
  }

  const entries = [];
  for (const [k, c] of counts) {
    const [pref, muni] = k.split("|");
    entries.push([pref, muni, c]);
  }
  entries.sort((a, b) => b[2] - a[2]);
  console.log(`  [baseball] matched=${matched}, prefOnlySkipped=${prefOnlyCount}, ${entries.length} muni entries`);
  console.log(`  [baseball] top 15:`);
  entries.slice(0, 15).forEach(([p, m, c]) => console.log(`    ${p} ${m}: ${c}`));
  await fs.writeFile(path.join(OUT, "baseball.json"), JSON.stringify(entries));
  console.log(`  → wrote baseball.json`);
}

async function fetchEarthquakeRaw() {
  console.log("[earthquake]");
  const url = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson"
    + "&starttime=1900-01-01&endtime=2025-12-31"
    + "&minmagnitude=5.0"
    + "&minlatitude=24&maxlatitude=46"
    + "&minlongitude=122&maxlongitude=146"
    + "&limit=20000";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
  const data = await res.json();
  // 軽量化: 必要なフィールド (coordinates, mag) だけ残す
  const slim = {
    type: "FeatureCollection",
    features: (data.features || []).map(f => ({
      geometry: { coordinates: f.geometry?.coordinates?.slice(0, 2) },
      properties: { mag: f.properties?.mag }
    }))
  };
  await writeRaw("earthquake-raw.json", slim);
  console.log(`  [earthquake] ${slim.features.length} events`);
}

// ----- main -----
const TASKS = {
  topo: fetchTopojsons,
  population: fetchPopulation,
  forest: fetchForest,
  restaurant: fetchRestaurant,
  density: fetchDensity,
  aging: fetchAging,
  avgAge: fetchAvgAge,
  vacancy: fetchVacancy,
  earthquake: fetchEarthquakeRaw,
  water100: fetchWaterVillage100,
  hyakumeizan: fetchHyakumeizan,
  nuclear: fetchNuclearPlants,
  dam: fetchLargeDams,
  military: fetchMilitaryBases,
  heisei: fetchHeiseiMergers,
  airraid: fetchAirRaids,
  park: fetchNationalParks,
  ohsho: fetchOhsho,
  yamaokaya: fetchYamaokaya,
  rasho: fetchRamenShop,
  yakimono: fetchYakimono,
  brandbeef: fetchBrandBeef,
  sake: fetchSake,
  airport: fetchAirports,
  baseball: fetchBaseball,
};

const args = process.argv.slice(2);
const targets = args.length ? args : Object.keys(TASKS);
for (const t of targets) {
  if (!TASKS[t]) { console.error(`unknown task: ${t}`); continue; }
  try {
    await TASKS[t]();
  } catch (e) {
    console.error(`[${t}] FAILED:`, e.message);
  }
}
console.log("done.");
