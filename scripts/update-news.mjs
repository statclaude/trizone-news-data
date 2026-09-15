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

async function gnewsTopHeadlines(country, category, max) {
  const url = `https://gnews.io/api/v4/top-headlines?country=${country}&category=${category}&max=${max}&token=${GNEWS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`top-headlines 실패: country=${country} category=${category} status=${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.articles || [];
}

// 오스틴은 country=us top-headlines로는 지역 뉴스가 안 나오므로, 검색 엔드포인트로 전환.
async function gnewsSearch(q, lang, max) {
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=${lang}&sortby=publishedAt&max=${max}&token=${GNEWS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`search 실패: q=${q} status=${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.articles || [];
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
