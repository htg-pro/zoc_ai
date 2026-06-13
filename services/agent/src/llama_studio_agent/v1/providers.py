"""Provider + model catalogue."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from shared_schema.models import ProviderDescriptor

from ..deps import get_state
from ..providers.openai import OpenAIProvider
from ..state import AppState

router = APIRouter(prefix="/providers", tags=["providers"])


@router.get("", response_model=list[ProviderDescriptor])
def list_providers(state: AppState = Depends(get_state)) -> list[ProviderDescriptor]:
    return state.providers.list()


class DiscoverModelsRequest(BaseModel):
    base_url: str
    api_key: str | None = None


class DiscoveredModel(BaseModel):
    id: str
    name: str


class DiscoverModelsResponse(BaseModel):
    models: list[DiscoveredModel]


@router.post("/discover-models", response_model=DiscoverModelsResponse)
async def discover_models(payload: DiscoverModelsRequest) -> DiscoverModelsResponse:
    """Fetch the live model list for an OpenAI-compatible provider using the
    supplied key. Lets the Settings UI replace its static catalogue with the
    provider's actual, current models the moment a key is entered.

    The key is used only for this request and never persisted server-side.
    """
    base_url = (payload.base_url or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="base_url is required.")
    provider = OpenAIProvider(api_key=payload.api_key, base_url=base_url)
    try:
        ids = await provider.list_remote_models()
    except Exception as exc:  # noqa: BLE001 — surface any failure as a 502
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch models from {base_url}: {exc}",
        ) from exc
    seen: set[str] = set()
    out: list[DiscoveredModel] = []
    for mid in sorted(ids, key=str.lower):
        if mid in seen:
            continue
        seen.add(mid)
        out.append(DiscoveredModel(id=mid, name=mid))
    return DiscoverModelsResponse(models=out)
