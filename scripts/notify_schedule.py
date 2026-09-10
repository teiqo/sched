#!/usr/bin/env python3
"""Called by deployment after publishing data, never polled by the bot."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

def main():
    if os.environ.get("SCHEDULE_CHANGED", "").strip().lower() != "true":
        print("Schedule push skipped: schedule.json content did not change.")
        return 0
    endpoint=os.environ.get("SCHED_NOTIFY_URL", "").strip()
    secret=os.environ.get("NOTIFY_SECRET", "").strip()
    if not endpoint or not secret:
        print("Push skipped: SCHED_NOTIFY_URL/NOTIFY_SECRET not configured for Actions.")
        return 0
    parsed=urlsplit(endpoint)
    if parsed.scheme != "https":
        print("Push endpoint must use HTTPS")
        return 1
    if not parsed.path.rstrip("/").endswith("/notify"):
        endpoint=urlunsplit(parsed._replace(path=parsed.path.rstrip("/")+"/notify"))
    data=json.loads((Path(__file__).resolve().parents[1]/"public/data/schedule.json").read_text())
    stamp=data.get("updatedAt")
    if not stamp: return 0
    payload={"type":"schedule", "format":"html", "event_id":"schedule:"+str(stamp),
             "text":"📅 <b>расписание обновлено</b>\n\nна сайте опубликована новая версия базового расписания.", "group":""}
    req=Request(endpoint,data=json.dumps(payload).encode(),headers={"Content-Type":"application/json","X-Sched-Token":secret})
    try:
        with urlopen(req, timeout=25) as response:
            result=json.load(response)
        if not result.get("ok"): return 1
        print("Schedule push accepted; duplicate stamps are not resent.")
        return 0
    except HTTPError as e:
        print("Push HTTP",e.code)
    except (URLError,OSError):
        print("Push network error (schedule deployment is already complete)")
    return 1

if __name__=="__main__": sys.exit(main())
