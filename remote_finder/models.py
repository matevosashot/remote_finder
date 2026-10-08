"""Request bodies shared by several routers."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

# What to do when a name already exists at the destination.
Conflict = Literal["replace", "keep", "skip"]


class PathBody(BaseModel):
    path: str


class PathsBody(BaseModel):
    paths: list[str]
