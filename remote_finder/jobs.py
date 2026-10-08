"""Background jobs (compress, extract, copy/move, delete, du) run in threads with progress and cancel."""

from __future__ import annotations

import itertools
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import APIRouter, HTTPException


class Cancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    kind: str
    title: str
    status: str = "running"  # running | done | error | cancelled
    done: int = 0            # progress units (bytes or items)
    total: int = 0           # 0 = unknown (indeterminate progress)
    message: str = ""
    result: Any = None
    error: str = ""
    started: float = field(default_factory=time.time)
    finished: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def check(self) -> None:
        """Raise Cancelled if the user pressed Cancel; call this often from the worker."""
        if self._cancel.is_set():
            raise Cancelled()

    def advance(self, n: int = 1, message: str | None = None) -> None:
        self.done += n
        if message is not None:
            self.message = message
        self.check()

    def public(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if not k.startswith("_")}


_jobs: dict[str, Job] = {}
_ids = itertools.count(1)
_lock = threading.Lock()


def _describe_error(e: Exception) -> str:
    if isinstance(e, OSError):
        return f"{e.strerror}: {e.filename}"
    return f"{type(e).__name__}: {e}"


def start(kind: str, title: str, fn: Callable[[Job], Any], cleanup: Callable[[], None] | None = None) -> Job:
    """Run fn(job) in a thread. `cleanup` runs if it fails or is cancelled."""
    job = Job(id=str(next(_ids)), kind=kind, title=title)
    with _lock:
        _jobs[job.id] = job
        # keep the registry small: drop finished jobs older than an hour
        cutoff = time.time() - 3600
        for jid in [j.id for j in _jobs.values() if j.finished and j.finished < cutoff]:
            del _jobs[jid]

    def run() -> None:
        # status is published last, after cleanup, so pollers never see a half-cleaned state
        try:
            job.result = fn(job)
            status = "done"
        except Cancelled:
            status = "cancelled"
        except Exception as e:  # surfaced to the UI as a toast
            job.error = _describe_error(e)
            status = "error"
            traceback.print_exc()
        if status != "done" and cleanup:
            cleanup()
        job.finished = time.time()
        job.status = status

    threading.Thread(target=run, name=f"job-{job.id}", daemon=True).start()
    return job


router = APIRouter(prefix="/api/jobs")


def _get(job_id: str) -> Job:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    return job


@router.get("")
def list_jobs() -> list[dict]:
    return [j.public() for j in sorted(_jobs.values(), key=lambda j: j.started, reverse=True)]


@router.get("/{job_id}")
def get_job(job_id: str) -> dict:
    return _get(job_id).public()


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    job = _get(job_id)
    job._cancel.set()
    return job.public()
