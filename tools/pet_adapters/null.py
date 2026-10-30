# -*- coding: utf-8 -*-
"""空适配器：未安装 / 主动关闭时使用，零副作用。"""
from __future__ import annotations

from pet_adapter import PetAdapter


class Adapter(PetAdapter):
    name = "null"


def build() -> Adapter:
    return Adapter()
