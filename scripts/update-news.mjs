// GitHub Actions에서 주기 실행:
//   1) 구글 뉴스 RSS(news.google.com/rss/search)로 별내(서울)/파리/오스틴 지역 뉴스 후보를 수집
//      — 도시별로 6가지 질의(전반/정치·행정/경제/사회/문화·예술/사건·사고)를 던져 다양성 있는 후보 풀을 만든다.
//      — GNews API는 더 이상 쓰지 않음(2026-09-16 교체): "지역과 관련은 있지만 며칠 지난 뉴스"가
//        섞여 들어오는 문제가 있어, 최근 24시간 이내로 필터링해 신선도를 보장한다(하루 단위 변화 반영).
//   1-1) (2026-09-17 추가) 구글 뉴스 톱스토리 피드(news.google.com/rss, 검색어 없음)로
//      한국/프랑스/미국 각각의 "오늘의 주요 뉴스" 후보도 함께 수집 — 도시별 지역 뉴스와는 완전히 별도 항목.
//   2) Gemini(무료 티어)에게 후보를 넘겨 "도시별 10개(지역성+분야 다양성) / 국가별 10개(주요도+분야
//      다양성)" 기준으로 선별시키고, 원문 언어와 무관하게 한국어 제목/요약을 직접 작성하게 함
//      (→ 번역 API가 따로 필요 없어짐: GitHub Actions에서 비공식 구글 번역이 막히는 문제를 우회)
//      — (2026-09-19 개선) 각 후보에 짧은 id를 매겨 Gemini에는 id/title/source/publishedAt만
//        보내고(url은 빼서 프롬프트 크기를 줄임), Gemini는 선택한 id + title_ko/summary_ko만
//        돌려주면 스크립트가 로컬 후보 목록에서 원본 url/source/publishedAt을 그대로 붙인다.
//        url을 Gemini가 다시 "타이핑"할 일이 없어져 속도·정확성이 함께 좋아진다.
//   3) news.json(앱이 fetch) + daily-news.md(사람이 저장소에서 읽는 기록용) 둘 다 저장
//      — news.json 키: seoul/paris/austin(도시 지역 뉴스), korea/france/usa(국가 주요 뉴스)
//
// 필요한 저장소 Secrets: GEMINI_API_KEY (필수), GEMINI_API_KEY_2 (선택 — 예비 키, 다른 Google
//   계정으로 발급받아 등록하면 첫 키의 무료 할당량이 소진됐을 때 자동으로 전환해서 씀)
// (GNEWS_API_KEY는 더 이상 사용하지 않음 — 저장소 Secrets에 남아있어도 무해하며, 지워도 됨)
//
// DRY_RUN=true 로 실행하면 뉴스 후보 수집(구글 뉴스 RSS)까지만 하고 Gemini 호출과
// news.json/daily-news.md 쓰기는 건너뛴다 — 워크플로/수집 로직만 확인할 때 무료 할당량을 안 쓰게 함.

// gemini-2.5-flash는 신규 API 키에는 더 이상 제공되지 않음 (실제 404 응답에서 확인,
// Google이 gemini-3.6-flash 사용을 안내함).
const GEMINI_MODEL = 'gemini-3.6-flash';

// 여러 계정의 API 키를 등록해두면(GEMINI_API_KEY, GEMINI_API_KEY_2 ...) 첫 키가
// 할당량 소진(429)으로 실패할 때 다음 키로 자동 전환한다 (아래 curateWithGemini 참고).
const GEMINI_API_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);

if (GEMINI_API_KEYS.length === 0) {
  console.error('GEMINI_API_KEY 환경변수가 없습니다 (저장소 Settings > Secrets and variables > Actions 에 등록 필요)');
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 구글 뉴스 RSS 수집 ----------
const GOOGLE_NEWS_BASE = 'https://news.google.com/rss/search';
const RSS_MIN_GAP_MS = 700; // 연속 요청 사이 최소 간격 (공용 서비스에 매너 있게 접근)
const RSS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let lastRssCallAt = 0;

function decodeEntities(str) {
  return String(str)
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function pickTag(block, tagRe) {
  const m = tagRe.exec(block);
  return m ? m[1] : null;
}

function parseGoogleNewsRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const titleRaw = pickTag(block, /<title>([\s\S]*?)<\/title>/);
    const linkRaw = pickTag(block, /<link>([\s\S]*?)<\/link>/);
    const pubDateRaw = pickTag(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceRaw = pickTag(block, /<source[^>]*>([\s\S]*?)<\/source>/);
    if (!titleRaw || !linkRaw) continue;

    let publishedAt = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw.trim());
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    // 구글 뉴스 RSS의 title은 보통 "기사 제목 - 출처명" 형태 — <source> 태그에 이미
    // 출처가 따로 있으므로, 뒤에 붙은 " - 출처명" 접미사는 제거해 후보 데이터를 깔끔하게 만든다.
    let title = decodeEntities(titleRaw);
    const source = sourceRaw ? decodeEntities(sourceRaw) : '';
    if (source && title.endsWith(' - ' + source)) {
      title = title.slice(0, -(' - ' + source).length).trim();
    }

    items.push({
      title,
      description: '',
      source,
      url: decodeEntities(linkRaw),
      publishedAt,
    });
  }
  return items;
}

async function fetchGoogleNewsFeed(url, label) {
  const wait = Math.max(0, RSS_MIN_GAP_MS - (Date.now() - lastRssCallAt));
  if (wait > 0) await sleep(wait);
  lastRssCallAt = Date.now();

  try {
    const res = await fetch(url, { headers: { 'User-Agent': RSS_UA } });
    if (!res.ok) {
      console.warn(`구글 뉴스 RSS 실패: ${label} status=${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseGoogleNewsRss(xml);
  } catch (e) {
    console.warn(`구글 뉴스 RSS 요청 오류: ${label} — ${e && e.message}`);
    return [];
  }
}

async function fetchGoogleNewsRss(query, hl, gl, ceid) {
  const url =
    `${GOOGLE_NEWS_BASE}?q=${encodeURIComponent(query)}` +
    `&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
  return fetchGoogleNewsFeed(url, `query="${query}"`);
}

// 검색어 없이 국가 에디션의 "오늘의 주요 뉴스"(구글 뉴스 톱스토리) 피드를 가져온다.
// — 국가 단위 뉴스(한국/프랑스/미국)에 쓴다. 도시별 검색과 달리 이미 구글이 분야를 섞어 놓은
//   상태라, 검색 질의를 여러 개로 나눌 필요가 없다.
async function fetchGoogleNewsTopStories(hl, gl, ceid) {
  const url = `https://news.google.com/rss?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
  return fetchGoogleNewsFeed(url, `top-stories hl=${hl} gl=${gl}`);
}

function dedupeByUrl(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// 며칠 지난 "지역 관련" 뉴스가 섞여 들어오는 문제(2026-09-16 발견) 대응:
// 발행 시각을 알 수 없거나 너무 오래된 기사는 큐레이션 대상에서 애초에 제외한다.
// (2026-09-16: 48시간은 "후보가 너무 적을까봐" 잡은 보수적인 값이었는데, 실제로는
//  48시간/4개 질의 기준으로도 도시당 87~270개나 모여 여유가 많았음 — 24시간으로 좁혀
//  "하루 단위 변화"를 실제로 보여주도록 하고, 대신 질의 카테고리를 늘려 후보 수를 보완한다.)
const MAX_ARTICLE_AGE_HOURS = 24;

function isRecentEnough(article) {
  if (!article.publishedAt) return false;
  const ageMs = Date.now() - new Date(article.publishedAt).getTime();
  return ageMs >= 0 && ageMs <= MAX_ARTICLE_AGE_HOURS * 3600 * 1000;
}

// Gemini에게 넘길 최소 필드만 남긴다.
function toCandidate(a) {
  return {
    title: a.title || '',
    description: a.description || '',
    source: a.source || '',
    url: a.url,
    publishedAt: a.publishedAt,
  };
}

// 후보마다 짧은 id를 매긴다(지역 prefix + 순번, 예: "s0", "p3"). 이 id로 Gemini와
// 주고받아서, url처럼 긴 값을 Gemini가 다시 타이핑하지 않아도 되게 한다.
function assignIds(candidates, prefix) {
  return candidates.map((c, i) => Object.assign({}, c, { id: `${prefix}${i}` }));
}

// Gemini 프롬프트에 실제로 보낼 축약형 — url(가장 긴 필드)과 빈 description은 빼서
// 프롬프트 크기를 줄인다. url/source/publishedAt은 결과를 받은 뒤 로컬 후보 목록에서
// id로 다시 찾아 붙인다(아래 resolvePicked 참고).
function toPromptCandidate(c) {
  const o = { title: c.title, source: c.source, publishedAt: c.publishedAt };
  if (c.id) o.id = c.id;
  return o;
}

async function collectCandidates(queries, hl, gl, ceid) {
  let all = [];
  for (const q of queries) {
    all = all.concat(await fetchGoogleNewsRss(q, hl, gl, ceid));
  }
  const deduped = dedupeByUrl(all);
  const fresh = deduped.filter(isRecentEnough);
  return fresh.map(toCandidate);
}

// 도시별 질의 계획: 전반 + 정치/행정 + 경제 + 사회 + 문화/예술 + 사건·사고 6갈래로 나눠
// 분야 다양성이 있는 후보 풀을 만든다(2026-09-16: 4갈래 → 6갈래로 확장).
// (검색어로 도시명을 직접 넣으므로, 별내는 서울 인근이라 "서울"로 검색 — country 단위보다 지역성이 나음)
const SEOUL_QUERIES = [
  '서울',
  '서울 정치 OR 정부 OR 시의회',
  '서울 경제 OR 기업 OR 부동산',
  '서울 사회',
  '서울 문화 OR 예술 OR 공연 OR 축제',
  '서울 사건 OR 사고',
];
const PARIS_QUERIES = [
  'Paris',
  'Paris politique OR gouvernement OR mairie',
  'Paris économie OR entreprise OR immobilier',
  'Paris société',
  'Paris culture OR art OR spectacle OR festival',
  'Paris incident OR accident OR fait divers',
];
const AUSTIN_QUERIES = [
  'Austin Texas',
  'Austin Texas government OR politics OR city council',
  'Austin Texas economy OR business OR jobs',
  'Austin Texas society OR community',
  'Austin Texas culture OR arts OR music OR festival',
  'Austin Texas incident OR accident OR crime',
];

async function collectSeoulCandidates() {
  return collectCandidates(SEOUL_QUERIES, 'ko', 'KR', 'KR:ko');
}
async function collectParisCandidates() {
  return collectCandidates(PARIS_QUERIES, 'fr', 'FR', 'FR:fr');
}
async function collectAustinCandidates() {
  return collectCandidates(AUSTIN_QUERIES, 'en-US', 'US', 'US:en');
}

// ---------- 국가 단위 "오늘의 주요 뉴스" 수집 (2026-09-17 추가) ----------
// 도시별 지역 뉴스와는 별도로, 한국/프랑스/미국 각각의 그날 주요 뉴스 10개를 추가한다.
async function collectNationCandidates(hl, gl, ceid) {
  const raw = await fetchGoogleNewsTopStories(hl, gl, ceid);
  const deduped = dedupeByUrl(raw);
  const fresh = deduped.filter(isRecentEnough);
  return fresh.map(toCandidate);
}

async function collectKoreaCandidates() {
  return collectNationCandidates('ko', 'KR', 'KR:ko');
}
async function collectFranceCandidates() {
  return collectNationCandidates('fr', 'FR', 'FR:fr');
}
async function collectUsaCandidates() {
  return collectNationCandidates('en-US', 'US', 'US:en');
}

// ---------- 필수 포함 키워드 (2026-09-16 추가) ----------
// 10대 뉴스 선별과는 별도로, 특정 키워드가 들어간 기사가 있으면 "부가 항목"으로 뒤에 반드시
// 붙인다(예: 파리의 오르세박물관, 오스틴의 UT). 10개를 채우는 일반 큐레이션 기준(분야 다양성 등)의
// 영향을 받지 않도록 완전히 별도 파이프라인으로 처리한다. 신선도 기준도 이 항목만 더 완화해서
// (기본 24시간 대신 7일) — 특정 키워드 뉴스는 매일 나오지 않을 수 있기 때문.
const MUST_INCLUDE_MAX_AGE_HOURS = 24 * 7;
const MUST_INCLUDE_QUERY = {
  paris: { query: "Musée d'Orsay", hl: 'fr', gl: 'FR', ceid: 'FR:fr' },
  austin: { query: 'University of Texas at Austin OR "UT Austin"', hl: 'en-US', gl: 'US', ceid: 'US:en' },
};

async function collectMustInclude(cityKey) {
  const cfg = MUST_INCLUDE_QUERY[cityKey];
  if (!cfg) return null;

  const raw = await fetchGoogleNewsRss(cfg.query, cfg.hl, cfg.gl, cfg.ceid);
  const deduped = dedupeByUrl(raw);
  const withinWindow = deduped.filter((a) => {
    if (!a.publishedAt) return false;
    const ageMs = Date.now() - new Date(a.publishedAt).getTime();
    return ageMs >= 0 && ageMs <= MUST_INCLUDE_MAX_AGE_HOURS * 3600 * 1000;
  });
  withinWindow.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  if (!withinWindow.length) {
    console.log(`필수 포함 키워드 "${cfg.query}" — 최근 ${MUST_INCLUDE_MAX_AGE_HOURS / 24}일 내 기사 없음, 이번엔 건너뜀`);
    return null;
  }
  return toCandidate(withinWindow[0]);
}

// ---------- Gemini 큐레이션 (선별 + 한국어 제목/요약 직접 작성) ----------
// REST API(fetch 직접 호출)에서는 type 값이 대문자 enum(STRING/OBJECT/ARRAY)이어야 함
// — SDK를 쓰면 SDK가 알아서 변환해주지만, 우리는 raw REST 호출이라 직접 맞춰야 한다.
// (2026-09-19) Gemini가 url/source/publishedAt을 다시 타이핑해서 돌려주는 대신, 후보의
// id만 골라 돌려주도록 스키마를 단순화했다 — 원본 값은 스크립트가 로컬에서 id로 찾아 붙인다.
function pickedItemSchema() {
  return {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      title_ko: { type: 'STRING' },
      summary_ko: { type: 'STRING' },
    },
    required: ['id', 'title_ko', 'summary_ko'],
  };
}

function pickedListSchema() {
  return { type: 'ARRAY', items: pickedItemSchema() };
}

// extras(필수 포함 항목)는 후보가 이미 "이 기사다"로 정해져 있어 id로 고를 필요가 없다 —
// Gemini는 한국어 제목/요약만 새로 작성해서 돌려주면 된다.
function extraItemSchema() {
  return {
    type: 'OBJECT',
    properties: {
      title_ko: { type: 'STRING' },
      summary_ko: { type: 'STRING' },
    },
    required: ['title_ko', 'summary_ko'],
  };
}

// 선택된 id 목록을 받아 로컬 후보 목록(candidateById)에서 원본 url/source/publishedAt을
// 찾아 붙인다. Gemini가 존재하지 않는 id를 돌려주는 경우(드물게 있을 수 있음)는 조용히
// 건너뛴다 — url을 임의로 지어내는 것보다 그 기사 하나가 빠지는 쪽이 훨씬 안전하다.
function resolvePicked(picked, candidateById, label) {
  const out = [];
  for (const item of picked || []) {
    const cand = candidateById.get(item.id);
    if (!cand) {
      console.warn(`${label}: 알 수 없는 id "${item.id}" — 건너뜀`);
      continue;
    }
    out.push({
      title_ko: item.title_ko,
      summary_ko: item.summary_ko,
      source: cand.source,
      url: cand.url,
      publishedAt: cand.publishedAt,
    });
  }
  return out;
}

// extras 항목 하나를 resolvePicked와 같은 형태로 만든다 — id가 아니라 mustIncludeCandidates
// 쪽에 이미 있는 원본 값을 그대로 쓴다.
function resolveExtra(extraFromGemini, mustIncludeCand) {
  if (!extraFromGemini || !mustIncludeCand) return null;
  return {
    title_ko: extraFromGemini.title_ko,
    summary_ko: extraFromGemini.summary_ko,
    source: mustIncludeCand.source,
    url: mustIncludeCand.url,
    publishedAt: mustIncludeCand.publishedAt,
  };
}

async function curateWithGemini(candidatesByRegion, mustIncludeCandidates) {
  const schema = {
    type: 'OBJECT',
    properties: {
      seoul: pickedListSchema(),
      paris: pickedListSchema(),
      austin: pickedListSchema(),
      korea: pickedListSchema(),
      france: pickedListSchema(),
      usa: pickedListSchema(),
      // extras: 10대 뉴스와 별도로 "반드시 포함" 키워드 후보가 있는 도시만 채워지는 부가 항목.
      // 최상위 required에 넣지 않고, extras 내부도 required를 두지 않아 — 후보가 없는 도시는
      // Gemini가 해당 필드를 만들지 않아도 스키마 위반이 되지 않는다.
      extras: {
        type: 'OBJECT',
        properties: {
          paris: extraItemSchema(),
          austin: extraItemSchema(),
        },
      },
    },
    required: ['seoul', 'paris', 'austin', 'korea', 'france', 'usa'],
  };

  // 프롬프트에는 url을 빼고 id/title/source/publishedAt만 보낸다(프롬프트 크기 축소).
  const promptCandidatesByRegion = {};
  for (const key of Object.keys(candidatesByRegion)) {
    promptCandidatesByRegion[key] = candidatesByRegion[key].map(toPromptCandidate);
  }
  const promptMustInclude = {};
  for (const key of Object.keys(mustIncludeCandidates || {})) {
    promptMustInclude[key] = toPromptCandidate(mustIncludeCandidates[key]);
  }

  const prompt = `당신은 일간 뉴스 큐레이터입니다. 아래 두 그룹의 후보 기사에서 각각 정확히 10개씩 선별하세요.
후보는 이미 최근 ${MAX_ARTICLE_AGE_HOURS}시간 이내로 필터링되어 있으니, 그 안에서는 최신순을 특별히 더
우대할 필요는 없습니다.

[그룹 1] 도시별 지역 뉴스 (seoul=별내/서울 인근, paris=파리, austin=오스틴/텍사스)
1. 오스틴은 반드시 실제 오스틴/텍사스 지역과 직접 관련된 기사만 선택하세요 (미국 전역 뉴스나 다른 지역 뉴스는 제외).
2. 세 도시 모두 정치/행정, 경제, 사회, 문화·예술, 사건·사고 등 다양한 분야가 골고루 섞이도록 선별하세요. 한 분야에 쏠리지 않게 하세요.

[그룹 2] 국가 단위 주요 뉴스 (korea=한국, france=프랑스, usa=미국)
3. 각 나라 전체를 대표하는 "오늘의 주요 뉴스" 10개를 선별하세요 — 정치, 경제, 사회, 국제, 문화 등
   다양한 분야가 골고루 섞이도록 하고, 한 나라/지역 이야기에만 쏠린 뉴스보다는 그 나라 전체적으로
   중요도가 높은 뉴스를 우선하세요.

공통 규칙:
4. 후보가 부족한 곳은 있는 만큼만 선택해도 됩니다 (억지로 10개를 채우지 마세요).
5. 선택한 기사는 후보 JSON에 있는 "id" 값을 그대로 반환하세요 (새로 만들어내지 마세요).
6. title_ko(한국어 제목)와 summary_ko(한국어로 1~2문장 요약)를 직접 작성하세요. 원문이 프랑스어/영어여도 반드시 자연스러운 한국어로 작성합니다.

필수 포함 항목(extras 필드, 아래 "필수 포함 후보" JSON 참고):
7. "필수 포함 후보"에 도시가 존재하면(예: paris, austin), extras.<도시>에 그 후보 기사를 기반으로
   title_ko/summary_ko를 새로 작성해 넣으세요 — 이 항목은 위 10대 뉴스 선별 기준(분야 다양성 등)과
   무관하게 무조건 포함하는 별도 항목입니다.
8. "필수 포함 후보"에 없는 도시는 extras에 그 도시의 키 자체를 만들지 마세요(빈 값도 넣지 말고 생략).

응답은 주어진 JSON 스키마만 따르세요. 다른 설명 텍스트는 포함하지 마세요.

후보 기사 (JSON, 키: seoul/paris/austin/korea/france/usa, 각 항목은 id/title/source/publishedAt):
${JSON.stringify(promptCandidatesByRegion)}

필수 포함 후보 (JSON, 각 항목은 title/source/publishedAt):
${JSON.stringify(promptMustInclude)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };

  // (2026-09-19) 여러 키를 등록해뒀으면 순서대로 시도한다. 503(일시 과부하)·네트워크
  // 오류(타임아웃 등, 2026-09-17 실측)는 같은 키로 몇 번 재시도할 가치가 있지만,
  // 429 RESOURCE_EXHAUSTED(무료 티어 하루 할당량 소진)는 같은 키로 아무리 재시도해도
  // 절대 안 풀리므로 — 예전처럼 5번씩 재시도하며 시간을 버리지 않고 즉시 다음 키로
  // 넘어간다(키가 하나뿐이면 그대로 실패). 이게 2026-09-19 발견된 "정기 실행조차 첫
  // 시도부터 429로 죽는" 문제의 핵심 원인이었다 — 재시도 자체가 이미 바닥난 할당량을
  // 계속 헛되이 두드려서, 워크플로 레벨 재시도(5분×3회)까지 전부 낭비하고 있었다.
  const RETRY_ATTEMPTS_PER_KEY = 3; // 503/네트워크 오류 전용 — 키당 최초 1회 + 재시도 2회
  let lastErrorText = '';

  for (let keyIndex = 0; keyIndex < GEMINI_API_KEYS.length; keyIndex++) {
    const apiKey = GEMINI_API_KEYS[keyIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const keyLabel = `키#${keyIndex + 1}/${GEMINI_API_KEYS.length}`;

    for (let attempt = 0; attempt < RETRY_ATTEMPTS_PER_KEY; attempt++) {
      let res;
      let networkError = null;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
      } catch (err) {
        networkError = err;
      }

      if (networkError) {
        const code = networkError?.cause?.code || networkError?.code || networkError?.name || 'unknown';
        lastErrorText = `Gemini 호출 실패(네트워크, ${keyLabel}): ${code} - ${networkError?.message || networkError}`;
        if (attempt < RETRY_ATTEMPTS_PER_KEY - 1) {
          const backoff = Math.min(8000 * Math.pow(2, attempt), 60000);
          console.warn(`${lastErrorText} — ${backoff}ms 후 재시도 (${attempt + 1}/${RETRY_ATTEMPTS_PER_KEY - 1})`);
          await sleep(backoff);
          continue;
        }
        break; // 이 키는 포기 — 다음 키로
      }

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          throw new Error('Gemini 응답에서 text를 찾을 수 없음: ' + JSON.stringify(data).slice(0, 500));
        }
        return JSON.parse(text);
      }

      const t = await res.text().catch(() => '');
      const isQuotaExhausted = res.status === 429 && /RESOURCE_EXHAUSTED|free_tier_requests/i.test(t);
      lastErrorText = `Gemini 호출 실패(${keyLabel}): status=${res.status} body=${t.slice(0, 500)}`;

      if (isQuotaExhausted) {
        console.warn(`${lastErrorText} — 무료 할당량 소진으로 판단, 이 키는 재시도하지 않고 다음 키로 전환`);
        break; // 같은 키로 재시도해봐야 소용없음 — 바로 다음 키
      }
      if (res.status === 503 && attempt < RETRY_ATTEMPTS_PER_KEY - 1) {
        const backoff = Math.min(8000 * Math.pow(2, attempt), 60000);
        console.warn(`${lastErrorText} — ${backoff}ms 후 재시도 (${attempt + 1}/${RETRY_ATTEMPTS_PER_KEY - 1})`);
        await sleep(backoff);
        continue;
      }
      break; // 그 외 오류(429지만 할당량 문제가 아닌 경우 등)도 이 키에서는 더 시도할 이유 없음
    }
    if (keyIndex < GEMINI_API_KEYS.length - 1) {
      console.warn(`${keyLabel} 실패 — 다음 키로 전환합니다.`);
    }
  }
  throw new Error(lastErrorText || 'Gemini 호출 실패: 알 수 없는 오류');
}

// ---------- 사람이 읽는 기록용 Markdown ----------
const CITY_LABEL = { seoul: '별내', paris: '파리', austin: '오스틴' };
const NATION_LABEL = { korea: '한국', france: '프랑스', usa: '미국' };
// 국가 뉴스 → 도시 뉴스 순서(예: 프랑스 뉴스 - 파리 뉴스)로 묶는다.
const REGION_GROUPS = [
  { nation: 'korea', city: 'seoul' },
  { nation: 'france', city: 'paris' },
  { nation: 'usa', city: 'austin' },
];

function toMarkdown(dateStr, articlesByRegion) {
  let md = `# ${dateStr} 뉴스 요약\n\n`;
  for (const g of REGION_GROUPS) {
    md += `## ${NATION_LABEL[g.nation]} (주요 뉴스)\n\n`;
    for (const a of articlesByRegion[g.nation] || []) {
      md += `- **${a.title_ko}** — ${a.source} (${a.publishedAt})\n  ${a.summary_ko}\n  ${a.url}\n\n`;
    }
    md += `## ${CITY_LABEL[g.city]} (지역 뉴스)\n\n`;
    for (const a of articlesByRegion[g.city] || []) {
      const pinnedTag = a.pinned ? ' 📌 필수 포함' : '';
      md += `- **${a.title_ko}**${pinnedTag} — ${a.source} (${a.publishedAt})\n  ${a.summary_ko}\n  ${a.url}\n\n`;
    }
  }
  return md;
}

// 10대 뉴스 뒤에 "필수 포함" 항목을 붙인다. 이미 10대 뉴스에 같은 url이 있으면 중복 추가하지 않음.
function buildFinalArticles(top10, extra) {
  const list = Array.isArray(top10) ? top10.slice() : [];
  if (extra && extra.url && !list.some((a) => a.url === extra.url)) {
    list.push(Object.assign({}, extra, { pinned: true }));
  }
  return list;
}

async function main() {
  const [seoulCandidates, parisCandidates, austinCandidates, koreaCandidates, franceCandidates, usaCandidates] = [
    assignIds(await collectSeoulCandidates(), 's'),
    assignIds(await collectParisCandidates(), 'p'),
    assignIds(await collectAustinCandidates(), 'a'),
    assignIds(await collectKoreaCandidates(), 'k'),
    assignIds(await collectFranceCandidates(), 'f'),
    assignIds(await collectUsaCandidates(), 'u'),
  ];

  console.log(
    '후보 수집 완료(최근 %d시간 이내) — seoul:%d paris:%d austin:%d / korea:%d france:%d usa:%d',
    MAX_ARTICLE_AGE_HOURS,
    seoulCandidates.length,
    parisCandidates.length,
    austinCandidates.length,
    koreaCandidates.length,
    franceCandidates.length,
    usaCandidates.length
  );

  const [parisMustInclude, austinMustInclude] = [
    await collectMustInclude('paris'),
    await collectMustInclude('austin'),
  ];
  const mustIncludeCandidates = {};
  if (parisMustInclude) mustIncludeCandidates.paris = parisMustInclude;
  if (austinMustInclude) mustIncludeCandidates.austin = austinMustInclude;
  console.log('필수 포함 후보:', JSON.stringify(mustIncludeCandidates));

  if (DRY_RUN) {
    console.log('DRY_RUN 모드 — Gemini 호출 및 news.json/daily-news.md 쓰기를 건너뜁니다.');
    return;
  }

  // id로 원본 후보를 다시 찾기 위한 로컬 맵(Gemini에는 안 보냄).
  const candidateById = new Map();
  for (const c of [
    ...seoulCandidates,
    ...parisCandidates,
    ...austinCandidates,
    ...koreaCandidates,
    ...franceCandidates,
    ...usaCandidates,
  ]) {
    candidateById.set(c.id, c);
  }

  const curated = await curateWithGemini(
    {
      seoul: seoulCandidates,
      paris: parisCandidates,
      austin: austinCandidates,
      korea: koreaCandidates,
      france: franceCandidates,
      usa: usaCandidates,
    },
    mustIncludeCandidates
  );

  const extras = curated.extras || {};
  const articlesByRegion = {
    seoul: buildFinalArticles(resolvePicked(curated.seoul, candidateById, 'seoul'), null),
    paris: buildFinalArticles(resolvePicked(curated.paris, candidateById, 'paris'), resolveExtra(extras.paris, mustIncludeCandidates.paris)),
    austin: buildFinalArticles(resolvePicked(curated.austin, candidateById, 'austin'), resolveExtra(extras.austin, mustIncludeCandidates.austin)),
    korea: buildFinalArticles(resolvePicked(curated.korea, candidateById, 'korea'), null),
    france: buildFinalArticles(resolvePicked(curated.france, candidateById, 'france'), null),
    usa: buildFinalArticles(resolvePicked(curated.usa, candidateById, 'usa'), null),
  };

  const now = Date.now();
  const output = {
    generatedAt: now,
    seoul: { fetchedAt: now, articles: articlesByRegion.seoul },
    paris: { fetchedAt: now, articles: articlesByRegion.paris },
    austin: { fetchedAt: now, articles: articlesByRegion.austin },
    korea: { fetchedAt: now, articles: articlesByRegion.korea },
    france: { fetchedAt: now, articles: articlesByRegion.france },
    usa: { fetchedAt: now, articles: articlesByRegion.usa },
  };

  const fs = await import('node:fs');
  fs.writeFileSync('news.json', JSON.stringify(output, null, 2));

  const dateStr = new Date(now).toISOString().slice(0, 10);
  fs.writeFileSync('daily-news.md', toMarkdown(dateStr, articlesByRegion));

  console.log(
    'news.json / daily-news.md 작성 완료 — seoul:%d paris:%d austin:%d / korea:%d france:%d usa:%d',
    output.seoul.articles.length,
    output.paris.articles.length,
    output.austin.articles.length,
    output.korea.articles.length,
    output.france.articles.length,
    output.usa.articles.length
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
