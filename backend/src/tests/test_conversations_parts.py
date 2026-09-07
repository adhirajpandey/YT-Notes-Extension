import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from src.conversations import service
from src.conversations.models import Conversation
from src.conversations.parts import (
    CitationPart,
    PartsDecoder,
    TextPart,
    model_part_adapter,
    transcript_context,
)
from src.conversations.schemas import MessageRead


def test_transcript_ids_and_timing():
    transcript = [
        {"text": "First", "offset": 1.25, "duration": 2.5},
        {"text": "Second", "offset": 5},
        {"text": "Third", "offset": 9},
    ]
    context, refs = transcript_context(transcript)
    assert context == transcript_context(json.loads(json.dumps(transcript)))[0]
    assert [(r.start_seconds, r.end_seconds) for r in refs.values()] == [
        (1.25, 3.75),
        (5, 9),
        (9, 9),
    ]
    changed = transcript_context([*transcript, {"text": "New", "offset": 10}])[1]
    assert not refs.keys() & changed.keys()


@pytest.mark.parametrize(
    "timing",
    [
        {},
        {"offset": -1},
        {"offset": True},
        {"offset": float("nan")},
        {"offset": float("inf")},
        {"offset": "10"},
        {"offset": 0, "duration": -1},
        {"offset": 0, "duration": None},
    ],
)
def test_uncitable_text_stays_in_context(timing):
    context, refs = transcript_context([{"text": "Untimed", **timing}])
    assert context == [{"text": "Untimed", "citable": False}]
    assert refs == {}


def test_missing_duration_uses_next_later_valid_offset():
    context, _ = transcript_context(
        [
            {"text": "First", "offset": 5},
            {"text": "Earlier", "offset": 3},
            {"text": "Unknown"},
            {"text": "Later", "offset": 8},
        ]
    )
    assert context[0]["end_seconds"] == 8


@pytest.mark.parametrize("width", [1, 2, 7, 4096])
def test_decoder_arbitrary_boundaries(width):
    parts = [
        {"type": "text", "text": '# Title\n\n```json\n{"x": "a\\b"}\n```\nक 😀'},
        {"type": "citation", "chunk_id": "chunk_1"},
        {"type": "text", "text": "**Last**"},
    ]
    payload = json.dumps({"parts": parts})
    decoder = PartsDecoder()
    actual = []
    for offset in range(0, len(payload), width):
        actual.extend(decoder.feed(payload[offset : offset + width]))
    assert [part.model_dump() for part in actual] == parts
    assert decoder.finish().parts == actual


def test_decoder_emits_before_envelope_finishes():
    decoder = PartsDecoder()
    assert list(decoder.feed('{"parts":[{"type":"text","text":"Ready"}')) == [
        TextPart(type="text", text="Ready")
    ]
    list(decoder.feed("]}"))
    decoder.finish()


@pytest.mark.parametrize(
    "payload",
    [
        '{"parts":[{"type":"text","text":"x"}]',
        '{"parts":[{"type":"text","text":"x"}],"extra":1}',
        '{"wrong":[{"type":"text","text":"x"}]}',
        '{"parts":[{"type":"text","text":"x","text":"y"}]}',
        '{"parts":[],"parts":[]}',
        '{"parts":[{"type":"text","text":"x"} {"type":"text","text":"y"}]}',
        '{"parts":[]} trailing',
        '{"parts":[{"type":"citation","chunk_id":"c","start_seconds":1}]}',
        '{"parts":[{"type":"tool","name":"seek"}]}',
    ],
)
def test_decoder_rejects_invalid_output(payload):
    with pytest.raises(ValueError):
        decoder = PartsDecoder()
        list(decoder.feed(payload))
        decoder.finish()


def test_model_cannot_supply_timestamps():
    with pytest.raises(ValidationError):
        model_part_adapter.validate_python(
            {"type": "citation", "chunk_id": "c", "start_seconds": 5}
        )
    with pytest.raises(ValidationError):
        CitationPart(type="citation", chunk_id="c", start_seconds=5, end_seconds=2)


def fake_provider(monkeypatch, payload, *, finish="stop", fail=False):
    captured, closed = {}, []

    class Stream:
        def __iter__(self):
            for char in payload:
                yield SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content=char), finish_reason=None
                        )
                    ]
                )
            if fail:
                raise RuntimeError("provider failed")
            yield SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        delta=SimpleNamespace(content=None), finish_reason=finish
                    )
                ]
            )

        def close(self):
            closed.append(True)

    def create(**kwargs):
        captured.update(kwargs)
        return Stream()

    monkeypatch.setattr(
        service,
        "OpenAI",
        lambda **kw: SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=create))
        ),
    )
    return captured, closed


def run_stream(db_session, *, history=None):
    conversation = Conversation(video_id="abc123DEF45", guest_session_id="guest")
    db_session.add(conversation)
    db_session.commit()
    conversation_id = conversation.id
    events = [
        json.loads(e.removeprefix("data: "))
        for e in service.stream_wiz_response(
            video_title="Test",
            transcript=[{"text": "Source", "offset": 763.5, "duration": 26.5}],
            history=history or [],
            conversation_id=conversation_id,
            db=db_session,
            api_key="test",
        )
    ]
    return events, service.list_messages(db_session, conversation_id)


def test_stream_resolves_persists_and_replays_parts(db_session, monkeypatch):
    _, refs = transcript_context(
        [{"text": "Source", "offset": 763.5, "duration": 26.5}]
    )
    chunk_id = next(iter(refs))
    parts = [
        {"type": "text", "text": "**Answer**"},
        {"type": "citation", "chunk_id": chunk_id},
        {"type": "citation", "chunk_id": "invented"},
        {"type": "text", "text": "More"},
    ]
    captured, closed = fake_provider(monkeypatch, json.dumps({"parts": parts}))
    history = [
        {
            "role": "assistant",
            "content": "Earlier",
            "metadata": {
                "parts_version": 1,
                "parts": [
                    {"type": "text", "text": "Earlier"},
                    refs[chunk_id].model_dump(),
                    {
                        "type": "citation",
                        "chunk_id": "old",
                        "start_seconds": 0,
                        "end_seconds": 1,
                    },
                ],
            },
        }
    ]
    events, messages = run_stream(db_session, history=history)
    assert [event["type"] for event in events] == ["text", "citation", "text", "done"]
    assert events[1] == refs[chunk_id].model_dump()
    assert len(messages) == 1
    assert events[-1]["message_id"] == messages[0].id
    read = MessageRead.model_validate(messages[0]).model_dump()
    assert read["parts"] == events[:-1]
    assert read["content"] == "**Answer**\n\nMore"
    assert captured["extra_body"] == {"provider": {"require_parameters": True}}
    assert captured["response_format"]["json_schema"]["strict"] is True
    assert json.loads(captured["messages"][1]["content"])["parts"] == [
        {"type": "text", "text": "Earlier"},
        {"type": "citation", "chunk_id": chunk_id},
    ]
    assert closed == [True]


@pytest.mark.parametrize(
    "finish,fail,suffix",
    [
        ("length", False, "]}"),
        (None, False, "]}"),
        ("stop", True, "]}"),
        ("stop", False, ""),
        ("stop", False, '],"extra":true}'),
    ],
)
def test_failed_stream_keeps_emitted_parts_without_persisting(
    db_session, monkeypatch, finish, fail, suffix
):
    fake_provider(
        monkeypatch,
        '{"parts":[{"type":"text","text":"Partial"}' + suffix,
        finish=finish,
        fail=fail,
    )
    events, messages = run_stream(db_session)
    assert events[0] == {"type": "text", "text": "Partial"}
    assert events[-1]["type"] == "error"
    assert not any(e["type"] == "done" for e in events)
    assert messages == []


def test_persistence_failure_never_emits_done(db_session, monkeypatch):
    fake_provider(monkeypatch, '{"parts":[{"type":"text","text":"Answer"}]}')

    def fail(*args, **kwargs):
        raise RuntimeError("storage failed")

    monkeypatch.setattr(service, "save_chat_message", fail)
    events, messages = run_stream(db_session)
    assert events[-1]["type"] == "error"
    assert messages == []


def test_legacy_message_remains_text(db_session):
    conversation = Conversation(video_id="abc123DEF45", user_id=1)
    db_session.add(conversation)
    db_session.commit()
    message = service.save_chat_message(
        db_session, conversation.id, "assistant", "Old [12:43]"
    )
    assert MessageRead.model_validate(message).parts == [
        TextPart(type="text", text="Old [12:43]")
    ]


@pytest.mark.asyncio
async def test_route_stream_and_history_contract(client, db_session, monkeypatch):
    from src.videos.models import Video

    video = Video(video_id="abc123DEF45", transcript_available=True, title="Video")
    conversation = Conversation(video_id=video.video_id, guest_session_id="parts-guest")
    db_session.add_all([video, conversation])
    db_session.commit()
    transcript = [{"text": "Source", "offset": 763.5, "duration": 26.5}]
    chunk_id = next(iter(transcript_context(transcript)[1]))
    fake_provider(
        monkeypatch,
        json.dumps(
            {
                "parts": [
                    {"type": "text", "text": "Answer"},
                    {"type": "citation", "chunk_id": chunk_id},
                ]
            }
        ),
    )
    monkeypatch.setattr(service, "get_transcript_from_s3", lambda _: transcript)
    headers = {"X-Guest-Session-ID": "parts-guest"}
    url = f"/v2/conversations/{conversation.id}/messages"
    response = await client.post(url, headers=headers, json={"message": "Explain"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [
        json.loads(block.removeprefix("data: "))
        for block in response.text.strip().split("\n\n")
    ]
    assert [event["type"] for event in events] == ["text", "citation", "done"]
    history = await client.get(url, headers=headers)
    messages = history.json()
    assert messages[0]["parts"] == [{"type": "text", "text": "Explain"}]
    assert messages[1]["parts"] == events[:-1]
    assert messages[1]["id"] == events[-1]["message_id"]
    denied = await client.get(url, headers={"X-Guest-Session-ID": "different"})
    assert denied.status_code == 404
