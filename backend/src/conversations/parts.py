"""Wiz's product parts, transcript references, and incremental JSON framing."""

import hashlib
import json
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class TextPart(StrictModel):
    type: Literal["text"]
    text: str


class ChunkReference(StrictModel):
    type: Literal["citation"]
    chunk_id: str = Field(min_length=1)


class CitationPart(ChunkReference):
    start_seconds: float = Field(ge=0, allow_inf_nan=False)
    end_seconds: float = Field(ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def ordered_times(self):
        if self.end_seconds < self.start_seconds:
            raise ValueError("Citation ends before it starts")
        return self


ModelPart = Annotated[TextPart | ChunkReference, Field(discriminator="type")]
MessagePart = Annotated[TextPart | CitationPart, Field(discriminator="type")]
model_part_adapter = TypeAdapter(ModelPart)
message_parts_adapter = TypeAdapter(list[MessagePart])


class ModelResponse(StrictModel):
    # Plain union generates portable anyOf JSON Schema without an OpenAPI discriminator.
    parts: list[TextPart | ChunkReference]


class DoneEvent(StrictModel):
    type: Literal["done"] = "done"
    message_id: int


class ErrorEvent(StrictModel):
    type: Literal["error"] = "error"
    message: str


def stored_parts(content: str, metadata: dict | None) -> list[MessagePart]:
    if metadata and metadata.get("parts_version") == 1:
        return message_parts_adapter.validate_python(metadata["parts"])
    return [TextPart(type="text", text=content)]


def text_projection(parts: list[MessagePart]) -> str:
    return "\n\n".join(part.text for part in parts if isinstance(part, TextPart))


def _seconds(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and number >= 0 else None


def transcript_context(transcript: list) -> tuple[list[dict], dict[str, CitationPart]]:
    revision = hashlib.sha256(
        json.dumps(
            transcript,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode()
    ).hexdigest()[:24]
    context = []
    references = {}
    for index, segment in enumerate(transcript):
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            continue
        start = _seconds(segment.get("offset"))
        duration = _seconds(segment.get("duration"))
        end = None
        if start is not None:
            if "duration" in segment:
                end = _seconds(start + duration) if duration is not None else None
            else:
                end = next(
                    (
                        offset
                        for later in transcript[index + 1 :]
                        if isinstance(later, dict)
                        and (offset := _seconds(later.get("offset"))) is not None
                        and offset > start
                    ),
                    start,
                )
        if start is None or end is None:
            context.append({"text": segment["text"], "citable": False})
            continue
        chunk_id = f"chunk_{revision}_{index}"
        citation = CitationPart(
            type="citation", chunk_id=chunk_id, start_seconds=start, end_seconds=end
        )
        references[chunk_id] = citation
        context.append(
            {
                "id": chunk_id,
                "text": segment["text"],
                "start_seconds": start,
                "end_seconds": end,
            }
        )
    return context, references


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


class PartsDecoder:
    """Frame complete objects without interpreting Markdown or incomplete strings.

    Final envelope validation is mandatory even after parts have been emitted.
    The scan cursor makes framing linear in the size of the provider response.
    """

    def __init__(self):
        self.buffer = ""
        self.stack = []
        self.in_string = False
        self.escaped = False
        self.part_start = None
        self.started = False
        self.parts = []

    def feed(self, delta: str):
        offset = len(self.buffer)
        self.buffer += delta
        if len(self.buffer) > 1_000_000:
            raise ValueError("Structured response too large")
        for index in range(offset, len(self.buffer)):
            char = self.buffer[index]
            if self.in_string:
                if self.escaped:
                    self.escaped = False
                elif char == "\\":
                    self.escaped = True
                elif char == '"':
                    self.in_string = False
                continue
            if char == '"':
                self.in_string = True
            elif char in "{[":
                if char == "{" and self.stack == ["{", "["]:
                    if not self.started:
                        prefix = json.loads(
                            self.buffer[:index] + "null]}",
                            object_pairs_hook=_unique_object,
                        )
                        if prefix != {"parts": [None]}:
                            raise ValueError("Invalid parts envelope")
                        self.started = True
                    self.part_start = index
                self.stack.append(char)
            elif char in "}]":
                if not self.stack or self.stack.pop() != ("{" if char == "}" else "["):
                    raise ValueError("Invalid JSON nesting")
                if (
                    char == "}"
                    and self.stack == ["{", "["]
                    and self.part_start is not None
                ):
                    value = json.loads(
                        self.buffer[self.part_start : index + 1],
                        object_pairs_hook=_unique_object,
                    )
                    part = model_part_adapter.validate_python(value)
                    self.parts.append(part)
                    self.part_start = None
                    yield part

    def finish(self) -> ModelResponse:
        response = ModelResponse.model_validate(
            json.loads(
                self.buffer,
                object_pairs_hook=_unique_object,
            )
        )
        if response.parts != self.parts:
            raise ValueError("Invalid streamed parts")
        return response
