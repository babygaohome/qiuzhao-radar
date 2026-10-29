#!/usr/bin/env python3
"""秋招雷达 · 把收集到的公司同步到微信云开发数据库

1. 读取 collect.py 的输出（out/catalog.json）和精选名单（seed/curated.json）
2. 生成云数据库导入文件 out/cloud_import.json（每行一条 JSON）
3. 如果设置了下面三个环境变量，就自动上传并导入；否则只生成文件，你可以在
   云开发控制台 → 数据库 → companies → 导入 里手动导入（冲突处理选 Upsert）

   WX_APPID   小程序 AppID
   WX_SECRET  小程序 AppSecret（小程序后台 → 开发管理 → 开发设置）
   WX_ENV     云开发环境 ID

   自动上传需要先把这台电脑的公网 IP 加到小程序后台的「IP 白名单」。

只用 Python 标准库。用法：
    python3 sync_cloud.py
    python3 sync_cloud.py --catalog out/catalog.json --dry-run
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.weixin.qq.com"
TODAY = dt.date.today().isoformat()


def company_key(name):
    s = re.sub(r"[（(][^）)]*[）)]", "", name or "")
    s = re.sub(r"\s+", "", s).lower()
    s = re.sub(r"(股份有限公司|有限责任公司|集团有限公司|有限公司|集团|控股|股份|公司)$", "", s)
    if s.startswith("中国") and len(s) >= 6:
        s = s[2:]
    return s


PLACES = "北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|香港|澳门|深圳|广州|杭州|南京|苏州|成都|武汉|西安|宁波|厦门|青岛|大连|长沙|郑州|济南|合肥|福州|昆明|南昌|沈阳|长春|哈尔滨|石家庄|太原|南宁|贵阳|兰州|海口|无锡|东莞|佛山|温州|绍兴|嘉兴|台州|金华|泉州|珠海|烟台|徐州|常州|南通|扬州|总行|总部"
BRANCH_RE = re.compile(rf"^(.{{2,12}}?)(?:股份有限公司|有限责任公司|有限公司|集团)?(?:{PLACES})(?:省|市|自治区|地区)?(?:分行|分公司|公司|支行|分院|分中心|中心支公司|营业部)$")

GROUP_ALIAS = {"招行": "招商银行", "建行": "建设银行", "工行": "工商银行", "农行": "农业银行", "中行": "中国银行", "交行": "交通银行", "邮储": "邮储银行", "中国工商银行": "工商银行", "中国农业银行": "农业银行", "中国建设银行": "建设银行", "中国邮政储蓄银行": "邮储银行", "中国交通银行": "交通银行", "中国平安": "平安", "中国石油天然气": "中国石油", "中石油": "中国石油", "中石化": "中国石化"}


def group_of(name):
    g = _raw_group_of(name)
    return GROUP_ALIAS.get(g, g)


def _raw_group_of(name):
    """分支机构归到所属集团（与云函数 crawler 的 groupOf 一致）"""
    n = re.sub(r"[（(][^）)]*[）)]", "", name or "").strip()
    m = re.match(r"^([^-－—·]{2,12})[-－—·].+$", n)
    if m:
        return m[1].strip()
    m = BRANCH_RE.match(n)
    if m:
        return m[1]
    m = re.match(r"^(.{2,12}?)(?:股份有限公司|有限公司)?.{2,8}(?:分行|分公司|支行)$", n)
    return m[1] if m else ""


def full_url(u):
    if not u:
        return ""
    return u if re.match(r"^https?://", u, re.I) else "https://" + u


def build_docs(catalog_path, curated_path, sync_id):
    curated = json.load(open(curated_path, encoding="utf-8"))
    catalog = json.load(open(catalog_path, encoding="utf-8")) if os.path.exists(catalog_path) else []
    docs, keys = [], set()

    for c in curated:
        keys.add(company_key(c["company"]))
        d = {
            "_id": c["id"], "company": c["company"], "industry": c.get("industry", "其他"), "ctype": c.get("ctype", ""),
            "batch": c.get("batch", ""), "openDate": c.get("openDate") or "", "openText": c.get("openText", ""),
            "deadline": c.get("deadline") or "", "deadlineText": c.get("deadlineText", ""),
            "url": full_url(c.get("url", "")), "agg": "", "note": c.get("note", ""), "cities": c.get("cities", ""),
            "updated": c.get("updatedAt", TODAY), "srcs": [], "v": "official", "agency": False, "source": "curated",
        }
        docs.append(d)

    for c in catalog:
        if company_key(c["company"]) in keys:
            continue                     # 精选名单里已有
        agg = c.get("url") or ("https://www.givemeoc.com/?" + urllib.parse.urlencode({"company_name": c["company"]})
                               if "offer多多" in (c.get("srcs") or []) else "")
        srcs = c.get("srcs") or []
        d = {
            "_id": c["id"], "company": c["company"], "industry": c.get("industry", "其他"), "ctype": c.get("ctype", ""),
            "batch": c.get("batch", ""), "openDate": c.get("openDate") or "", "openText": "",
            "deadline": c.get("deadline") or "", "deadlineText": c.get("deadlineText", ""),
            "url": c.get("ou", ""), "agg": agg, "note": c.get("note", ""), "cities": c.get("cities", ""),
            "updated": c.get("updated", ""), "srcs": srcs,
            "v": c.get("v") or ("multi" if len(srcs) >= 2 else "single"),
            "agency": bool(c.get("agency")), "tags": c.get("tags") or [], "source": "auto",
        }
        docs.append(d)

    for d in docs:
        d["dl"] = d["deadline"] or "9999-12-31"          # 没有截止日期的排在最后，也不会被当成已截止
        d["group"] = group_of(d["company"]) if d["source"] == "auto" else ""
        d["search"] = f'{d["company"]} {d["group"]} {d["industry"]} {d["note"]} {d["cities"]}'.lower()
        d["syncId"] = sync_id
    return docs


# ---------------------------------------------------------------- 微信云开发 HTTP API

def call(path, token, body):
    req = urllib.request.Request(f"{API}{path}?access_token={token}", data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read().decode())
    if res.get("errcode", 0) != 0:
        raise RuntimeError(f"{path} 失败：{res.get('errcode')} {res.get('errmsg')}")
    return res


def get_token(appid, secret):
    q = urllib.parse.urlencode({"grant_type": "client_credential", "appid": appid, "secret": secret})
    with urllib.request.urlopen(f"{API}/cgi-bin/token?{q}", timeout=30) as r:
        res = json.loads(r.read().decode())
    if "access_token" not in res:
        hint = "（把这台电脑的公网 IP 加到小程序后台 → 开发管理 → 开发设置 → IP 白名单）" if res.get("errcode") == 40164 else ""
        raise RuntimeError(f"获取 access_token 失败：{res.get('errcode')} {res.get('errmsg')}{hint}")
    return res["access_token"]


def upload(token, env, cloud_path, local_path):
    info = call("/tcb/uploadfile", token, {"env": env, "path": cloud_path})
    boundary = uuid.uuid4().hex
    fields = {"key": cloud_path, "Signature": info["authorization"], "x-cos-security-token": info["token"],
              "x-cos-meta-fileid": info["cos_file_id"]}
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{os.path.basename(local_path)}"\r\n'
                 f'Content-Type: application/json\r\n\r\n'.encode())
    parts.append(open(local_path, "rb").read())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(info["url"], data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        if r.status not in (200, 204):
            raise RuntimeError(f"上传文件失败：HTTP {r.status}")


def ensure_collection(token, env, name):
    try:
        call("/tcb/databasecollectionadd", token, {"env": env, "collection_name": name})
        print(f"  新建集合 {name}")
    except RuntimeError as e:
        if "exist" not in str(e).lower() and "-502005" not in str(e):
            raise


def sync(docs, import_path, appid, secret, env, sync_id):
    token = get_token(appid, secret)
    for name in ("companies", "apps", "profiles", "meta"):
        ensure_collection(token, env, name)

    cloud_path = f"sync/companies-{sync_id}.json"
    print(f"  上传 {os.path.getsize(import_path) // 1024} KB …")
    upload(token, env, cloud_path, import_path)

    job = call("/tcb/databasemigrateimport", token, {"env": env, "collection_name": "companies", "file_path": cloud_path,
                                                     "file_type": 1, "stop_on_error": False, "conflict_mode": 2})["job_id"]
    print(f"  导入中（任务 {job}）…")
    for _ in range(120):
        time.sleep(5)
        st = call("/tcb/databasemigratequeryinfo", token, {"env": env, "job_id": job})
        if st.get("status") in ("success", "fail"):
            print(f"  导入{'完成' if st['status'] == 'success' else '失败'}：成功 {st.get('record_success')} 条，失败 {st.get('record_fail')} 条")
            if st["status"] != "success":
                raise RuntimeError(f"导入失败，详情见 {st.get('error_file_url') or '云开发控制台'}")
            break
    else:
        raise RuntimeError("导入超过 10 分钟还没结束，去云开发控制台看看")

    # 删掉这次没出现的自动收集公司（已截止或已下线）；精选、手动添加和云端定时采集写入的不动
    res = call("/tcb/databasedelete", token, {"env": env, "query":
               f'db.collection("companies").where({{source:"auto",syncId:db.command.nin(["{sync_id}","crawler"])}}).remove()'})
    print(f"  清理下线公司 {res.get('deleted', 0)} 家")

    meta = {"updatedAt": TODAY, "companies": len(docs), "syncId": sync_id}
    call("/tcb/databasedelete", token, {"env": env, "query": 'db.collection("meta").where({_id:"catalog"}).remove()'})
    call("/tcb/databaseadd", token, {"env": env, "query":
         f'db.collection("meta").add({{data:[{json.dumps({"_id": "catalog", **meta}, ensure_ascii=False)}]}})'})
    print("  已更新 meta/catalog")


def main():
    ap = argparse.ArgumentParser(description="同步公司数据到微信云开发")
    ap.add_argument("--catalog", default=os.path.join(HERE, "out", "catalog.json"))
    ap.add_argument("--curated", default=os.path.join(HERE, "seed", "curated.json"))
    ap.add_argument("--dry-run", action="store_true", help="只生成导入文件，不上传")
    args = ap.parse_args()

    sync_id = dt.datetime.now().strftime("%Y%m%d%H%M")
    docs = build_docs(args.catalog, args.curated, sync_id)
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    import_path = os.path.join(HERE, "out", "cloud_import.json")
    with open(import_path, "w", encoding="utf-8") as fh:
        for d in docs:
            fh.write(json.dumps(d, ensure_ascii=False) + "\n")
    print(f"生成 {import_path}：{len(docs)} 家公司")

    appid, secret, env = os.environ.get("WX_APPID"), os.environ.get("WX_SECRET"), os.environ.get("WX_ENV")
    if args.dry_run or not (appid and secret and env):
        if not args.dry_run:
            print("没有设置 WX_APPID / WX_SECRET / WX_ENV，跳过自动上传。")
        print("手动导入：云开发控制台 → 数据库 → companies → 导入 → 选这个文件，冲突处理选 Upsert。")
        return
    try:
        sync(docs, import_path, appid, secret, env, sync_id)
        print("同步完成")
    except Exception as e:
        print(f"同步失败：{e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
