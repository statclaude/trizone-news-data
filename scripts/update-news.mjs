// GitHub Actions에서 주기 실행:
//   1) GNews로 별내(kr)/파리(fr)/오스틴(지역 검색) 후보 기사를 넉넉히 수집
//   2) Gemini(무료 티어)에게 후보를 넘겨 "도시당 10개, 분야 다양성 + 오스틴은 실제 지역성" 기준으로
//      선별시키고, 원문 언어와 무관하게 한국어 제목/요약을 직접 작성하게 함
//      (→ 번역 API가 따로 필요 없어짐: GitHub Actions에서 비공식 구글 번역이 막히는 문제를 우회)
//   3) news.json(앱이 fetch) + daily-news.md(사람이 저장소에서 읽는 기록용) 둘 다 저장
//
// 필요한 저장소 Secrets: GNEWS_API_KEY, GEMINI_API_KEY

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

if (!GNEWS_API_KEY) {
  console.error('GNEWS_API_KEY 환경변수가 없습니다 (저장소 Settings > Secrets and variables > Actions 에 등록 필요)');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY 환경변수가 없습니다 (저장소 Settings > Secrets and variables > Actions 에 등록 필요)');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- GNews 후보 수집 (간격 + 429 재시도는 이전 실행에서 검증된 방식 유지) ----------
let lastGnewsCallAt = 0;
const GNEWS_MIN_GAP_MS = 1200;

async function gnewsRequest(url, label) {
  const wait = Math.max(0, GNEWS_MIN_GAP_MS - (Date.now() - lastGnewsCallAt));
  if (wait > 0) await sleep(wait);
  lastGnewsCallAt = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      return data.articles || [];
    }
    if (res.status === 429 && attempt < 2) {
      const backoff = 2500 * (attempt + 1);
      console.warn(`${label}: 429 rate limited, ${backoff}ms 후 재시도`);
      await sleep(backoff);
      lastGnewsCallAt = Date.now();
      continue;
    }
    const bodyText = await res.text().catch(() => '');
    console.warn(`${label} 실패: status=${res.status} body=${bodyText.slice(0, 200)}`);
    return [];
  }
  return [];
}

async function gnewsTopHeadlines(country, category, max) {
  const url = `https://gnews.io/api/v4/top-headlines?country=${country}&category=${category}&max=${max}&token=${GNEWS_API_KEY}`;
  return gnewsRequest(url, `top-headlines country=${country} category=${category}`);
}

async function gnewsSearch(q, lang, max) {
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=${lang}&sortby=publishedAt&max=${max}&token=${GNEWS_API_KEY}`;
  return gnewsRequest(url, `search q=${q}`);
}

function dedupeByUrl(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// Gemini에게 넘길 최소 필드만 남긴다 (title/description/source/url/publishedAt).
function toCandidate(a) {
  return {
    title: a.title || '',
    description: a.description || '',
    source: (a.source && a.source.name) || '',
    url: a.url,
    publishedAt: a.publishedAt,
  };
}

// 정치/사회, 경제, IT·과학, 문화 4개 분야 각각 넉넉히(최대 10개씩) 모아 Gemini가 고를 풀을 키운다.
const CATEGORY_PLAN = ['nation', 'business', 'technology', 'entertainment'];

async function collectSeoulCandidates() {
  let all = [];
  for (const category of CATEGORY_PLAN) {
    all = all.concat(await gnewsTopHeadlines('kr', category, 10));
  }
  return dedupeByUrl(all).map(toCandidate);
}

async function collectParisCandidates() {
  let all = [];
  for (const category of CATEGORY_PLAN) {
    all = all.concat(await gnewsTopHeadlines('fr', category, 10));
  }
  return dedupeByUrl(all).map(toCandidate);
}

// 오스틴은 country=us top-headlines로는 지역 뉴스가 안 나오므로 검색 엔드포인트 사용.
// 분야별로 나눠 검색해 다양성 있는 후보 풀을 만든다.
const AUSTIN_QUERIES = [
  'Austin Texas',
  'Austin Texas government OR politics OR city council',
  'Austin Texas economy OR business OR jobs',
  'Austin Texas culture OR music OR arts OR festival',
];

async function collectAustinCandidates() {
  let all = [];
  for (const q of AUSTIN_QUERIES) {
    all = all.concat(await gnewsSearch(q, 'en', 10));
  }
  return dedupeByUrl(all).map(toCandidate);
}

// ---------- Gemini 큐레이션 (선별 + 한국어 제목/요약 직접 작성) ----------
function articlesSchema() {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        title_ko: { type: 'string' },
        summary_ko: { type: 'string' },
        source: { type: 'string' },
        url: { type: 'string' },
        publishedAt: { type: 'string' },
      },
      required: ['title_ko', 'summary_ko', 'source', 'url', 'publishedAt'],
    },
  };
}

async function curateWithGemini(candidatesByCity) {
  const schema = {
    type: 'object',
    properties: {
      seoul: articlesSchema(),
      paris: articlesSchema(),
      austin: articlesSchema(),
    },
    required: ['seoul', 'paris', 'austin'],
  };

  const prompt = `당신은 세 지역(별내=한국 서울 인근, 파리=프랑스, 오스틴=미국 텍사스)의 일간 뉴스 큐레이터입니다.
아래 각 도시별 후보 기사 목록에서 도시당 정확히 10개를 선별하세요.

선별 기준:
1. 오스틴은 반드시 실제 오스틴/텍사스 지역과 직접 관련된 기사만 선택하세요 (미국 전역 뉴스나 다른 지역 뉴스는 제외).
2. 세 도시 모두 정치/사회, 경제, IT·과학, 문화·연예 등 다양한 분야가 골고루 섞이도록 선별하세요. 한 분야에 쏠리지 않게 하세요.
3. 후보가 부족한 도시는 있는 만큼만 선택해도 됩니다 (억지로 10개를 채우지 마세요).
4. title_ko(한국어 제목)와 summary_ko(한국어로 1~2문장 요약)를 직접 작성하세요. 원문이 프랑스어/영어여도 반드시 자연스러운 한국어로 작성합니다.
5. source, url, publishedAt은 후보 기사에 있는 원본 값을 그대로 사용하세요 (임의로 만들어내지 마세요).
6. 응답은 주어진 JSON 스키마만 따르세요. 다른 설명 텍스트는 포함하지 마세요.

후보 기사 (JSON):
${JSON.stringify(candidatesByCity)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini 호출 실패: status=${res.status} body=${t.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini 응답에서 text를 찾을 수 없음: ' + JSON.stringify(data).slice(0, 500));
  }
  return JSON.parse(text);
}

// ---------- 사람이 읽는 기록용 Markdown ----------
const CITY_LABEL = { seoul: '별내', paris: '파리', austin: '오스틴' };

function toMarkdown(dateStr, curated) {
  let md = `# ${dateStr} 지역 뉴스 요약\n\n`;
  for (const city of ['seoul', 'paris', 'austin']) {
    md += `## ${CITY_LABEL[city]}\n\n`;
    for (const a of curated[city] || []) {
      md += `- **${a.title_ko}** — ${a.source} (${a.publishedAt})\n  ${a.summary_ko}\n  ${a.url}\n\n`;
    }
  }
  return md;
}

async function main() {
  const [seoulCandidates, parisCandidates, austinCandidates] = [
    await collectSeoulCandidates(),
    await collectParisCandidates(),
    await collectAustinCandidates(),
  ];

  console.log(
    '후보 수집 완료 — seoul:%d paris:%d austin:%d',
    seoulCandidates.length,
    parisCandidates.length,
    austinCandidates.length
  );

  const curated = await curateWithGemini({
    seoul: seoulCandidates,
    paris: parisCandidates,
    austin: austinCandidates,
  });

  const now = Date.now();
  const output = {
    generatedAt: now,
    seoul: { fetchedAt: now, articles: curated.seoul || [] },
    paris: { fetchedAt: now, articles: curated.paris || [] },
    austin: { fetchedAt: now, articles: curated.austin || [] },
  };

  const fs = await import('node:fs');
  fs.writeFileSync('news.json', JSON.stringify(output, null, 2));

  const dateStr = new Date(now).toISOString().slice(0, 10);
  fs.writeFileSync('daily-news.md', toMarkdown(dateStr, curated));

  console.log(
    'news.json / daily-news.md 작성 완료 — seoul:%d paris:%d austin:%d',
    output.seoul.articles.length,
    output.paris.articles.length,
    output.austin.articles.length
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
