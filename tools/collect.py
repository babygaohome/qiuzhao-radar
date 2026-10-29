#!/usr/bin/env python3
"""秋招雷达 · 公司收集脚本

从几个公开的校招汇总站抓取 2027届 在招公司，合并去重、统一行业分类，
输出为可以直接写入「秋招雷达」网页数据库的分片文件。

只用 Python 标准库。用法：
    python3 collect.py                 # 抓全部来源
    python3 collect.py --max-pages 3   # 每个来源只抓前 3 页（试跑）
    python3 collect.py --sources niuqi,qiuzhaowang

输出（默认 ./out）：
    catalog.json     合并后的全部公司（给人看 / 调试用）
    shards/sNN.json  分片，每片一个数据库文档（collection "catalog"，doc_id = sNN）
    manifest.json    本次分片清单、需要删除的旧分片、各来源统计
"""
import functools
print = functools.partial(print, flush=True)
import argparse, datetime as dt, hashlib, html, json, os, re, sys, time, urllib.parse, urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 qiuzhao-radar/1.0"
TODAY = dt.date.today()
SHARD_BYTES = 150_000          # 单个数据库文档上限 256 KiB，留足余量
BATCH_BYTES = 850_000          # 一次写入请求上限 1 MiB

# ---------------------------------------------------------------- http

def fetch(url, delay):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read().decode("utf-8", errors="ignore")
            time.sleep(delay)
            return body
        except Exception as e:
            print(f"  ! {url} 第{attempt + 1}次失败: {e}", file=sys.stderr)
            time.sleep(delay * 3)
    return ""

def text(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()

# ---------------------------------------------------------------- normalise

def parse_deadline(s):
    """返回 (ISO 日期 或 None, 文字说明)"""
    s = (s or "").strip()
    m = re.search(r"(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})", s)
    if m:
        return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}", ""
    m = re.search(r"(\d{1,2})月(\d{1,2})日", s)
    if m:
        mon, day = int(m[1]), int(m[2])
        year = TODAY.year + (1 if mon < TODAY.month - 3 else 0)
        return f"{year}-{mon:02d}-{day:02d}", ""
    if re.search(r"招满|额满|滚动", s):
        return None, "招满即止"
    return None, "未公布"

CTYPE_RULES = [
    (r"央|国企|国有", "央国企"),
    (r"外企|外资|合资", "外企/合资"),
    (r"事业|高校|科研院所|政府|机关", "事业单位"),
    (r"民企|民营", "民企"),
]
def norm_ctype(s):
    for pat, v in CTYPE_RULES:
        if re.search(pat, s or ""):
            return v
    return ""

INDUSTRY_RULES = [   # 先看来源给的行业，再看公司名
    (r"游戏", "游戏"),
    (r"半导体|芯片|集成电路|晶圆", "芯片/半导体"),
    (r"互联网|电商|电子商务", "互联网"),
    (r"计算机|软件|IT|信息技术|人工智能|大数据|云计算", "软件/IT"),
    (r"通信|电信|网络设备|移动|联通|铁塔", "通信"),
    (r"电子|电路|智能硬件|家电|消费电子", "电子/硬件"),
    (r"汽车|摩托车|新能源车|整车", "汽车"),
    (r"证券|基金|期货|资管|信托", "证券/基金"),
    (r"银行|农商|农信|信用社", "银行"),
    (r"投资", "证券/基金"),
    (r"保险|人寿|财险|再保", "保险"),
    (r"金融", "其他金融"),
    (r"咨询|会计|审计|律师|法律|专业服务|四大", "咨询/四大"),
    (r"医|药|生物|健康", "医药/医疗"),
    (r"能源|电力|电网|采掘|冶炼|石油|石化|煤|核电|水电|光伏|环保|燃气", "能源/电力"),
    (r"化工|材料|电气", "化工/材料"),
    (r"机械|制造|重工|设备|装备|航天|航空工业|商飞|兵器|船舶|中车", "机械/制造"),
    (r"快速消费|快消|食品|饮料|零售|批发|贸易|服装|纺织|餐饮|酒店|旅游|日化", "快消/零售"),
    (r"建筑|房地产|物业|建材|工程|建工|基建|中铁|中建|铁建|交建|城建", "建筑/地产"),
    (r"交通|物流|仓储|航空|铁路|港口|航运|快递|机场", "交通/物流"),
    (r"传媒|广告|文化|出版|娱乐|影视|体育", "传媒/文化"),
    (r"教育|培训|科研|研究院|研究所|高校|大学", "教育/科研"),
    (r"政府|事业|组织|农林|烟草", "政府/事业"),
]
def norm_industry(source_industry, company):
    for hay in (source_industry or "", company or ""):
        for pat, v in INDUSTRY_RULES:
            if re.search(pat, hay):
                return v
    return "其他"

def clean_company(name):
    name = html.unescape(name or "").strip()
    name = re.sub(r"(20\d\d|\d\d)届.*$", "", name)
    name = re.sub(r"(校园招聘|校招|秋招|春招|招聘简章|招聘公告|简章).*$", "", name)
    return name.strip(" ,，|-·")

def company_key(name):
    s = re.sub(r"[（(][^）)]*[）)]", "", name)
    s = re.sub(r"\s+", "", s).lower()
    s = re.sub(r"(股份有限公司|有限责任公司|集团有限公司|有限公司|集团|控股|股份|公司)$", "", s)
    if s.startswith("中国") and len(s) >= 6:
        s = s[2:]
    return s

# 是否校招：批次里只有社招 / 博士后 / 高层次人才、没有任何校招字样的不收录
CAMPUS_RE = r"校招|秋招|春招|管培|应届|毕业生|届|提前批|补录|校园|双选会|专场|正式批"
def campus_tags(batch_text, company):
    """返回 None 表示不是校招（不收录），否则返回标签列表"""
    t = batch_text or ""
    if re.search(r"博士后", company or ""):
        return None
    if not re.search(CAMPUS_RE, t) and re.search(r"社招|博士后|高层次人才", t):
        return None
    tags = []
    if "社招" in t:
        tags.append("含社招")
    if re.search(r"博士|高层次人才", t):
        tags.append("博士岗")
    return tags

def short(s, n):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"

# ---------------------------------------------------------------- sources
# 每个来源产出统一的 dict：company, industry_raw, ctype_raw, batch, openDate,
# deadline_raw, url, positions, cities, updated, src

def src_qiuzhaowang(max_pages, delay):
    """秋招网：列表行的 data-* 属性里有全部字段。"""
    out, seen_ids = [], set()
    for page in range(1, max_pages + 1):
        url = f"https://qiuzhaowang.com/?year=2027&page={page}"
        body = fetch(url, delay)
        rows = re.findall(r"<article class=\"job-row\"(.*?)>", body, flags=re.S)
        ids = {m for r in rows for m in re.findall(r'data-job-id="([^"]*)"', r)}
        if not rows or ids <= seen_ids:
            break
        seen_ids |= ids
        for attrs in rows:
            a = {k: html.unescape(v) for k, v in re.findall(r'data-job-([a-z-]+)="([^"]*)"', attrs)}
            if not a.get("company"):
                continue
            mm = re.match(r"(\d{1,2})月(\d{1,2})日", a.get("update", ""))
            updated = ""
            if mm:
                y = TODAY.year - (1 if (int(mm[1]), int(mm[2])) > (TODAY.month, TODAY.day) else 0)
                updated = f"{y}-{int(mm[1]):02d}-{int(mm[2]):02d}"
            out.append(dict(
                company=a["company"], industry_raw=a.get("industry", ""), ctype_raw=a.get("company-type", ""),
                batch=a.get("batch", ""), openDate=None, deadline_raw=a.get("deadline", ""),
                url="https://qiuzhaowang.com" + a["href"].split("?")[0] if a.get("href") else "",
                positions=a.get("title", ""), cities=a.get("city", ""), updated=updated, src="秋招网"))
        print(f"  秋招网 第{page}页 {len(rows)} 条")
    return out

NIUQI_INDUSTRIES = {
    "internet": "互联网", "computersoftwarehardwareservices": "计算机软件/硬件/服务",
    "telecomnetworkequipment": "通信/电信/网络设备", "electronicscircuitsemiconductor": "电子/电路/半导体",
    "financesecuritiesinvestment": "金融/证券/投资", "banking": "银行", "insurance": "保险", "fmcg": "快速消费品",
    "tradeimportexport": "贸易/进出口", "governmentinstitutionngofarming": "政府/事业/组织/农林牧渔",
    "culturemediaadvertisingpaper": "文化/广告/传媒/造纸", "automotivemotorcycleparts": "汽车/摩托车/零配件",
    "pharmaceuticalmedicalequipment": "制药/医疗/医疗设备", "energyminingmetallurgy": "能源/采掘/冶炼",
    "constructionmaterialsengineering": "建筑/建材/工程", "chemicalelectrical": "化工/电气",
    "machineryequipmentheavyindustry": "机械/设备/重工", "transportationlogisticswarehousing": "交通/物流/仓储",
    "realestateproperty": "房地产/物业", "clothingtextile": "服装/纺织", "homeappliances": "家电",
    "wholesaleretail": "批发/零售", "hoteltourism": "酒店/旅游", "cateringrestaurant": "餐饮",
    "entertainmentleisuresportlife": "娱乐/休闲/体育/生活服务",
    "educationtrainingconsultinglaw": "专业服务/教育/培训/咨询/法律", "other": "其他",
}

def _niuqi_cards(body):
    for c in re.findall(r'<article class="schedule-card">(.*?)</article>', body, flags=re.S):
        tag = text((re.search(r'schedule-card-tags"[^>]*>(.*?)</span>', c, flags=re.S) or [None, ""])[1])
        m = re.search(r'schedule-card-company">\s*<a href="([^"]+)" title="([^"]*)"[^>]*>(.*?)</a>', c, flags=re.S)
        if not m:
            continue
        href, title, h3 = m[1], html.unescape(m[2]), text(m[3])
        heading = text((re.search(r'schedule-card-title">(.*?)</h4>', c, flags=re.S) or [None, ""])[1])
        dates = text((re.search(r'title="网申日期">(.*?)</span>', c, flags=re.S) or [None, ""])[1])
        posted = text((re.search(r'title="收录日期">(.*?)</span>', c, flags=re.S) or [None, ""])[1])
        cities = text((re.search(r'title="招聘城市">(.*?)</span>', c, flags=re.S) or [None, ""])[1])
        pos = ",".join(text(p) for p in re.findall(r'class="job-postion">(.*?)</span>', c, flags=re.S))
        yield dict(tag=tag, href=href, title=title, h3=h3, heading=heading, dates=dates,
                   posted=posted, cities=cities, positions=pos)

def src_niuqi(max_pages, delay):
    """牛企直聘：按行业分页抓，行业来自所在分类。"""
    seen, out = set(), []
    for slug, label in NIUQI_INDUSTRIES.items():
        for page in range(1, max_pages + 1):
            body = fetch(f"https://campus.niuqizp.com/schedulenew-{slug}-all-{page}/", delay)
            cards = list(_niuqi_cards(body))
            if not cards or all(c["href"] in seen for c in cards):
                break                       # 超出最后一页时站点会重复返回末页
            for c in cards:
                if c["href"] in seen:
                    continue
                seen.add(c["href"])
                if re.search(r"实习|大使|宣讲", c["tag"]):
                    continue
                blob = c["h3"] + c["heading"]
                if re.search(r"(2026|26)届", blob) and not re.search(r"(2027|27)届", blob):
                    continue
                name = c["h3"].split(" ")[0].split(",")[0].split("，")[0]
                full = clean_company(c["title"])
                ds = re.findall(r"20\d\d-\d\d-\d\d", c["dates"])
                out.append(dict(
                    company=clean_company(name) or full, full=full, industry_raw=label, ctype_raw="",
                    batch="校招" if c["tag"] == "校招" else c["tag"], openDate=ds[0] if ds else None,
                    deadline_raw=ds[1] if len(ds) > 1 else "",
                    url="https://campus.niuqizp.com" + c["href"], positions=c["positions"],
                    cities=c["cities"], updated=c["posted"], src="牛企直聘"))
            print(f"  牛企直聘 {label} 第{page}页 {len(cards)} 条")
    attach_official_links(out, delay)
    return out

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "official_links.json")
# 这些是招聘汇总/信息站，不算公司官方渠道；mokahr、zhiye、feishu、zhaopin 子域等企业自建招聘系统算官方
NOT_OFFICIAL = r"niuqizp\.com|qiuzhaowang\.com|givemeoc\.com|yingjiesheng\.com|dajie\.com|offershow|job592|91job|haitou|kanzhun|jobui|tianyancha|qcc\.com|baidu\.com"

def attach_official_links(rows, delay):
    """每家公司取最新一条公告，打开详情页读「查看公告原文」链接。结果缓存，以后只抓新增的。"""
    try:
        cache = json.load(open(CACHE, encoding="utf-8"))
    except Exception:
        cache = {}
    newest = {}
    for r in rows:
        k = company_key(clean_company(r["company"]))
        if k not in newest or (r["updated"] or "") > (newest[k]["updated"] or ""):
            newest[k] = r
    todo = [r for r in newest.values() if r["url"] not in cache]
    print(f"  牛企直聘 需要打开 {len(todo)} 个详情页读取官方公告链接（已缓存 {len(cache)} 个）")
    for i, r in enumerate(todo, 1):
        body = fetch(r["url"], delay)
        if not body:
            continue
        m = re.search(r'<a href="(https?://[^"]+)" class="post-button"', body)
        cache[r["url"]] = m[1] if m else ""
        if i % 100 == 0:
            print(f"  牛企直聘 详情页 {i}/{len(todo)}")
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    for r in rows:
        link = cache.get(r["url"], "")
        if link and not re.search(NOT_OFFICIAL, link):
            r["official"] = link

def src_givemeoc(max_pages, delay):
    """offer多多 汇总表：按 2027届 过滤、屏蔽已截止。"""
    out, seen_ids = [], set()
    for page in range(1, max_pages + 1):
        q = urllib.parse.urlencode({"target_candidates": "2027", "deadline_range": "exclude_expired", "paged": page})
        body = fetch(f"https://www.givemeoc.com/?{q}", delay)
        rows = re.findall(r'<tr data-id="\d+">(.*?)</tr>', body, flags=re.S)
        ids = set(re.findall(r'<tr data-id="(\d+)">', body))
        if not rows or ids <= seen_ids:
            break
        seen_ids |= ids
        stale = 0
        for r in rows:
            f = {k: text(v) for k, v in re.findall(r'<td class="crt-col-([a-z-]+)">(.*?)</td>', r, flags=re.S)}
            if "2027" not in f.get("target", ""):
                continue
            if f.get("update-time", "") < f"{TODAY.year - 1}-12-01":
                stale += 1
            out.append(dict(
                company=f.get("company", ""), industry_raw=f.get("industry", ""), ctype_raw=f.get("type", ""),
                batch=f.get("recruitment-type", ""), openDate=None, deadline_raw=f.get("deadline", ""),
                url="https://www.givemeoc.com/?" + urllib.parse.urlencode({"company_name": f.get("company", "")}),
                positions=f.get("position", ""), cities=f.get("location", ""), updated=f.get("update-time", ""),
                src="offer多多"))
        print(f"  offer多多 第{page}页 {len(rows)} 条")
        if stale == len(rows):
            break
    return out

SOURCES = {"qiuzhaowang": src_qiuzhaowang, "niuqi": src_niuqi, "givemeoc": src_givemeoc}
SRC_RANK = {"牛企直聘": 0, "秋招网": 1, "offer多多": 2}     # 链接优先级：有网申日期和原文摘要的在前

# ---------------------------------------------------------------- merge

def merge(rows):
    groups = {}
    for r in rows:
        r["company"] = clean_company(r["company"])
        if len(r["company"]) < 2:
            continue
        if re.search(r"实习|intern", (r["batch"] or "") + (r.get("tag") or ""), flags=re.I):
            continue                                          # 只要秋招/校招全职
        dl, dl_txt = parse_deadline(r["deadline_raw"])
        if dl and dl < TODAY.isoformat():
            continue                                          # 已截止
        r["deadline"], r["deadlineText"] = dl, dl_txt
        groups.setdefault(company_key(r["company"]), []).append(r)

    items = []
    for key, rs in groups.items():
        rs.sort(key=lambda r: SRC_RANK.get(r["src"], 9))
        names = sorted({r["company"] for r in rs}, key=len)
        dated = sorted(r["deadline"] for r in rs if r["deadline"])
        opens = sorted(r["openDate"] for r in rs if r.get("openDate"))
        txts = {r["deadlineText"] for r in rs if not r["deadline"]}
        industry = next((norm_industry(r["industry_raw"], r["company"]) for r in rs
                         if norm_industry(r["industry_raw"], r["company"]) != "其他"), "其他")
        ctype = next((norm_ctype(r["ctype_raw"]) for r in rs if norm_ctype(r["ctype_raw"])), "")
        batches = []
        for r in rs:
            b = re.sub(r"^2027届\s*", "", r["batch"] or "").strip()
            if b and b not in batches:
                batches.append(b)
        pos = []
        for r in rs:
            for p in re.split(r"[,，、/\\]+", r["positions"] or ""):
                p = p.strip()
                if p and p not in pos and not re.search(r"届|校园招聘|启动", p):
                    pos.append(p)
        url = rs[0]["url"]
        if rs[0]["src"] == "offer多多":
            url = ""                                            # 网页按公司名自己拼 offer多多 搜索链接
        official = next((r["official"] for r in rs if r.get("official")), "")
        verify = "official" if official else ("multi" if len({r["src"] for r in rs}) >= 2 else "single")
        tags = campus_tags(" ".join(r["batch"] or "" for r in rs), names[0])
        if tags is None:
            continue                                          # 社招 / 博士后专场，不是校招
        agency = bool(re.search(r"猎头|人力资源|劳务|派遣|外包|人才服务|人力科技|招聘服务", names[0] + " ".join(pos[:6])))
        items.append({
            "id": "a" + hashlib.sha1(key.encode()).hexdigest()[:10],
            "ou": official,
            "v": verify,
            "agency": agency or None,
            "company": names[0],
            "industry": industry,
            "ctype": ctype,
            "batch": short(" / ".join(batches[:3]), 24),
            "tags": tags,
            "openDate": opens[0] if opens else None,
            "deadline": dated[-1] if dated else None,
            "deadlineText": "" if dated else ("招满即止" if "招满即止" in txts else "未公布"),
            "url": url,
            "note": short("、".join(pos[:6]), 48),
            "cities": short(rs[0]["cities"].replace(" · ", ",").replace("，", ","), 36),
            "updated": max((r["updated"] or "" for r in rs), default=""),
            "srcs": sorted({r["src"] for r in rs}, key=lambda s: SRC_RANK.get(s, 9)),
        })
    items.sort(key=lambda x: (x["updated"] or ""), reverse=True)
    # 去掉空字段，减小体积
    return [{k: v for k, v in it.items() if v not in ("", None, [])} for it in items]

def write_shards(items, out_dir):
    shard_dir = os.path.join(out_dir, "shards")
    os.makedirs(shard_dir, exist_ok=True)
    for f in os.listdir(shard_dir):
        os.remove(os.path.join(shard_dir, f))
    shards, cur, size = [], [], 0
    for it in items:
        n = len(json.dumps(it, ensure_ascii=False).encode()) + 1
        if cur and size + n > SHARD_BYTES:
            shards.append(cur); cur, size = [], 0
        cur.append(it); size += n
    if cur:
        shards.append(cur)
    paths = []
    stamp = TODAY.isoformat()
    for i, sh in enumerate(shards):
        p = os.path.join(shard_dir, f"s{i:02d}.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"items": sh, "part": i, "parts": len(shards), "updatedAt": stamp}, fh, ensure_ascii=False)
        paths.append(os.path.abspath(p))
    return paths

def batches(paths):
    """把分片分组，每组总大小不超过一次写入请求的上限"""
    groups, cur, size = [], [], 0
    for i, p in enumerate(paths):
        n = os.path.getsize(p)
        if cur and size + n > BATCH_BYTES:
            groups.append(cur); cur, size = [], 0
        cur.append({"op": "set", "collection": "catalog", "doc_id": f"s{i:02d}", "file_path": p}); size += n
    if cur:
        groups.append(cur)
    return groups

def main():
    ap = argparse.ArgumentParser(description="收集 2027届 在招公司")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    ap.add_argument("--sources", default="niuqi,qiuzhaowang,givemeoc")
    ap.add_argument("--max-pages", type=int, default=400, help="每个来源（牛企直聘为每个行业）最多抓几页")
    ap.add_argument("--delay", type=float, default=1.0, help="两次请求之间的间隔秒数，别调太小")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    # 各来源是不同站点，并行抓取；同一站点内仍按 --delay 间隔依次请求
    from concurrent.futures import ThreadPoolExecutor
    names = [s.strip() for s in args.sources.split(",") if s.strip()]
    rows, stats = [], {}
    with ThreadPoolExecutor(len(names)) as pool:
        results = {n: pool.submit(SOURCES[n], args.max_pages, args.delay) for n in names}
    for n, fut in results.items():
        got = fut.result()
        stats[n] = len(got)
        rows += got

    items = merge(rows)
    with open(os.path.join(args.out, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)

    manifest_path = os.path.join(args.out, "manifest.json")
    prev = 0
    if os.path.exists(manifest_path):
        try:
            prev = json.load(open(manifest_path, encoding="utf-8")).get("parts", 0)
        except Exception:
            pass
    paths = write_shards(items, args.out)
    manifest = {
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "companies": len(items), "rawRows": stats, "parts": len(paths),
        "batches": batches(paths),
        "meta": {"updatedAt": TODAY.isoformat(), "companies": len(items), "parts": len(paths), "rawRows": stats},
        "deleteShards": [f"s{i:02d}" for i in range(len(paths), max(prev, len(paths)))],
    }
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)

    by_ind = {}
    for it in items:
        by_ind[it["industry"]] = by_ind.get(it["industry"], 0) + 1
    print(f"\n完成：原始 {sum(stats.values())} 条 → 去重后 {len(items)} 家在招公司，{len(paths)} 个分片")
    print("  " + "  ".join(f"{k} {v}" for k, v in sorted(by_ind.items(), key=lambda x: -x[1])))
    print(f"  输出目录 {os.path.abspath(args.out)}")

if __name__ == "__main__":
    main()
