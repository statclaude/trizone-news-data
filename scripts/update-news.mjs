// GitHub Actions에서 주기 실행: GNews(카테고리 분산 + 오스틴은 /search로 지역 특정)로
// 뉴스를 가져오고, 파리/오스틴 기사는 무료 비공식 구글 번역 엔드포인트로 번역해
// news.json 하나로 합쳐서 저장한다. trizone-clock 앱은 이 파일만 fetch한다.

const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
if (!GNEWS_API_KEY) {
  console.error('GNEWS_API_KEY 환경변수가 없습니다 (저장소 Settings > Secrets and variables > Actions 에 등록 필요)');
  process.exit(1);
}

// 정치/사회, 경제, IT·과학, 문화 4개 분야로 나눠 골고루 뽑는다 (총 10개).
const CATEGORY_PLAN = [
  { category: 'nation', count: 3 },
  { category: 'business', count: 3 },
  { category: 'technology', count: 2 },
  { category: 'entertainment', count: 2 },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 첫 실행에서 seoul(nation)만 성공하고 나머지 8건이 전부 비어있었던 원인 =
// GNews 호출을 간격 없이 연달아 쏴서 순간 요청 제한(429)에 걸린 것으로 추정.
// 호출 사이 최소 간격 + 429 재시도(백오프)를 둔다.
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

// 오스틴은 country=us top-headlines로는 지역 뉴스가 안 나오므로, 검색 엔드포인트로 전환.
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

// title+description을 구분자로 합쳐 한 번의 호출로 번역 (기사당 번역 요청 최대 1회).
async function translateCombined(title, description) {
  const marker = ' @@8172@@ ';
  const combined = title + marker + description;
  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=' +
      encodeURIComponent(combined);
    const res = await fetch(url);
    const data = await res.json();
    const translated = (data[0] || []).map((seg) => seg[0] || '').join('');
    const parts = translated.split(/@@\s*8172\s*@@/);
    if (parts.length < 2) throw new Error('split-failed');
    return { title: parts[0].trim(), description: parts.slice(1).join('').trim(), ok: true };
  } catch (e) {
    return { title, description, ok: false };
  }
}

async function buildCityBundle(needsTranslation, fetchArticles) {
  const raw = dedupeByUrl(await fetchArticles());
  const articles = [];
  for (const a of raw.slice(0, 10)) {
    const item = {
      title: a.title || '',
      description: a.description || '',
      translatedTitle: a.title || '',
      translatedDescription: a.description || '',
      source: (a.source && a.source.name) || '',
      url: a.url,
      publishedAt: a.publishedAt,
      translateFailed: false,
    };
    if (needsTranslation && item.title) {
      const t = await translateCombined(item.title, item.description);
      item.translatedTitle = t.title;
      item.translatedDescription = t.description;
      item.translateFailed = !t.ok;
      await sleep(300); // 동시 다발 요청 방지
    }
    articles.push(item);
  }
  return { fetchedAt: Date.now(), articles };
}

async function main() {
  const seoul = await buildCityBundle(false, async () => {
    let all = [];
    for (const { category, count } of CATEGORY_PLAN) {
      all = all.concat(await gnewsTopHeadlines('kr', category, count));
    }
    return all;
  });

  const paris = await buildCityBundle(true, async () => {
    let all = [];
    for (const { category, count } of CATEGORY_PLAN) {
      all = all.concat(await gnewsTopHeadlines('fr', category, count));
    }
    return all;
  });

  const austin = await buildCityBundle(true, async () => gnewsSearch('Austin', 'en', 10));

  const output = {
    generatedAt: Date.now(),
    seoul,
    paris,
    austin,
  };

  const fs = await import('node:fs');
  fs.writeFileSync('news.json', JSON.stringify(output, null, 2));
  console.log('news.json 작성 완료 — seoul:%d paris:%d austin:%d', seoul.articles.length, paris.articles.length, austin.articles.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
