import json
import pytest

from src.auth.schemas import ViewerContext
from src.conversations import service as conversations_service
from src.conversations.config import conversations_settings
from src.conversations.models import Conversation
from src.exceptions import RateLimitError, NotFoundError, InternalServerError
from src.videos.models import Video


def test_get_or_create_video_creates_and_schedules_tasks(db_session, monkeypatch):
    scheduled_calls = []

    def fake_schedule(db, video):
        scheduled_calls.append(video.video_id)

    monkeypatch.setattr(conversations_service, "schedule_video_tasks", fake_schedule)

    video, created = conversations_service.get_or_create_video(
        db_session, "abc123DEF45"
    )
    assert created is True
    assert video.video_id == "abc123DEF45"
    assert scheduled_calls == ["abc123DEF45"]


def test_get_valid_transcript_or_raise_missing_video(db_session):
    with pytest.raises(NotFoundError):
        conversations_service.get_valid_transcript_or_raise(db_session, "abc123DEF45")


def test_get_valid_transcript_or_raise_returns_none_when_not_ready(db_session):
    video = Video(video_id="abc123DEF45", title="Video", transcript_available=False)
    db_session.add(video)
    db_session.commit()
    assert (
        conversations_service.get_valid_transcript_or_raise(db_session, "abc123DEF45")
        is None
    )


def test_build_system_instruction_formats_transcript():
    transcript = [
        {"offset": 1, "text": "Hello"},
        {"offset": 61, "text": "World"},
    ]
    instruction = conversations_service.build_system_instruction("Title", transcript)
    assert '"start_seconds": 1.0' in instruction
    assert '"text": "Hello"' in instruction
    assert '"start_seconds": 61.0' in instruction
    assert "chunk_" in instruction


def test_check_daily_quota_enforces_limit(db_session, monkeypatch):
    monkeypatch.setattr(
        conversations_settings, "wiz_user_daily_quota", 1, raising=False
    )
    conversation = Conversation(video_id="abc123DEF45", user_id=1)
    db_session.add(conversation)
    db_session.commit()

    conversations_service.save_chat_message(
        db_session,
        conversation.id,
        conversations_service.DB_ROLE_USER,
        "Hello",
    )

    with pytest.raises(RateLimitError):
        conversations_service.check_daily_quota(
            db_session, user_id=1, guest_session_id=None
        )


def test_prepare_chat_returns_processing_when_transcript_missing(db_session):
    video = Video(video_id="abc123DEF45", title="Video", transcript_available=False)
    conversation = Conversation(video_id=video.video_id, user_id=1)
    db_session.add_all([video, conversation])
    db_session.commit()

    viewer = ViewerContext(user_id=1)
    result = conversations_service.prepare_chat(
        db_session, conversation, viewer, "hello"
    )
    assert result == (None, None, [], None)


def test_get_transcript_from_s3_returns_none_without_config(monkeypatch):
    monkeypatch.setattr(
        conversations_settings,
        "s3_transcript_bucket_name",
        None,
        raising=False,
    )
    assert conversations_service.get_transcript_from_s3("abc123DEF45") is None


def test_get_transcript_from_s3_fetches_when_configured(monkeypatch):
    monkeypatch.setattr(
        conversations_settings,
        "s3_transcript_bucket_name",
        "bucket",
        raising=False,
    )
    monkeypatch.setattr(
        conversations_settings, "aws_access_key_id", "key", raising=False
    )
    monkeypatch.setattr(
        conversations_settings, "aws_secret_access_key", "secret", raising=False
    )
    monkeypatch.setattr(
        conversations_settings, "aws_region", "us-east-1", raising=False
    )

    class _Body:
        def read(self):
            return json.dumps([{"text": "hi", "offset": 0}]).encode("utf-8")

    captured = {}

    class _S3:
        def get_object(self, Bucket, Key):
            captured["Bucket"] = Bucket
            captured["Key"] = Key
            return {"Body": _Body()}

    monkeypatch.setattr(
        conversations_service.boto3, "client", lambda *args, **kwargs: _S3()
    )
    transcript = conversations_service.get_transcript_from_s3("abc123DEF45")
    assert transcript == [{"text": "hi", "offset": 0}]
    assert captured == {
        "Bucket": "bucket",
        "Key": "transcripts/abc123DEF45.json",
    }


def test_ensure_openrouter_api_key_raises(monkeypatch):
    monkeypatch.setattr(
        conversations_settings, "openrouter_api_key", None, raising=False
    )
    with pytest.raises(InternalServerError):
        conversations_service.ensure_openrouter_api_key()


def test_prepare_chat_returns_history_when_transcript_ready(db_session, monkeypatch):
    monkeypatch.setattr(
        conversations_settings, "openrouter_api_key", "key", raising=False
    )
    monkeypatch.setattr(
        conversations_settings, "wiz_user_daily_quota", 99, raising=False
    )

    video = Video(video_id="abc123DEF45", title="Video", transcript_available=True)
    conversation = Conversation(video_id=video.video_id, user_id=1)
    db_session.add_all([video, conversation])
    db_session.commit()

    monkeypatch.setattr(
        conversations_service,
        "get_transcript_from_s3",
        lambda _video_id: [{"text": "hi", "offset": 0}],
    )

    viewer = ViewerContext(user_id=1)
    video_out, transcript, history, api_key = conversations_service.prepare_chat(
        db_session, conversation, viewer, "hello"
    )

    assert video_out.video_id == video.video_id
    assert transcript == [{"text": "hi", "offset": 0}]
    assert history[-1]["content"] == "hello"
    assert api_key == "key"


def test_stream_wiz_response_yields_error_on_empty_content(db_session, monkeypatch):
    conversation = Conversation(video_id="abc123DEF45", user_id=1)
    db_session.add(conversation)
    db_session.commit()

    class _Delta:
        content = None

    class _Choice:
        delta = _Delta()

    class _Chunk:
        choices = [_Choice()]

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    return [_Chunk(), _Chunk()]

    monkeypatch.setattr(conversations_service, "OpenAI", lambda **kwargs: _FakeClient())

    events = list(
        conversations_service.stream_wiz_response(
            video_title="Test",
            transcript=[{"text": "hi", "offset": 0}],
            history=[{"role": "user", "content": "hello"}],
            conversation_id=conversation.id,
            db=db_session,
            api_key="key",
        )
    )

    error_events = [e for e in events if "error" in e and "No response" in e]
    assert len(error_events) == 1
    assert json.loads(events[-1].removeprefix("data: "))["type"] == "error"
    assert len(events) == 1
