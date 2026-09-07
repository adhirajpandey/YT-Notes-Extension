"""Capture deterministic VidWiz UI screenshots with Playwright.

Examples (run from the repository root):
  uv -C backend run --locked python ../scripts/screenshot_pages.py --list
  uv -C backend run --locked python ../scripts/screenshot_pages.py --pages landing dashboard --sizes mobile desktop
  uv -C backend run --locked python ../scripts/screenshot_pages.py --all --sizes mobile desktop --browser-mode headless
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence
from urllib.parse import urlparse

from dotenv import load_dotenv
from playwright.sync_api import Browser, BrowserContext, Page, Response
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = Path(__file__).resolve().parent / ".env"

DEFAULT_UI_BASE_URL = "http://localhost:5173"
DEFAULT_API_BASE_URL = "http://localhost:5000/v2"
DEFAULT_OUTPUT_DIR = "scripts/outputs/ui-images"

load_dotenv(ENV_FILE, override=False)


@dataclass(frozen=True)
class ViewportPreset:
    alias: str
    width: int
    height: int


@dataclass(frozen=True)
class PageCapture:
    alias: str
    path: str
    ready_text: str
    authenticated: bool = False
    dynamic_video: bool = False
    wiz_workspace: bool = False


@dataclass(frozen=True)
class RuntimeConfig:
    ui_base_url: str
    api_base_url: str
    output_dir: Path
    email: str | None
    password: str | None
    video_id: str | None
    navigation_timeout_ms: int
    scroll_overlap_px: int
    post_scroll_settle_ms: int
    max_screenshots_per_page: int


@dataclass(frozen=True)
class CliOptions:
    pages: list[PageCapture]
    sizes: list[ViewportPreset]
    headless: bool


VIEWPORT_PRESETS = {
    "desktop": ViewportPreset("desktop", 1920, 1080),
    "mobile": ViewportPreset("mobile", 390, 844),
}

PAGE_CAPTURES = {
    "landing": PageCapture("landing", "/", "Talk to the video."),
    "login": PageCapture("login", "/login", "Welcome back"),
    "signup": PageCapture("signup", "/signup", "Create your account"),
    "wiz": PageCapture("wiz", "/wiz", "Meet Wiz"),
    "privacy": PageCapture("privacy", "/privacy", "Your Privacy Matters"),
    "help": PageCapture("help", "/help", "Set Up VidWiz"),
    "dashboard": PageCapture(
        "dashboard", "/dashboard", "Your Videos", authenticated=True
    ),
    "profile": PageCapture("profile", "/profile", "User Details", authenticated=True),
    "video": PageCapture(
        "video",
        "/dashboard/{video_id}",
        "Your Notes",
        authenticated=True,
        dynamic_video=True,
    ),
    "wiz-workspace": PageCapture(
        "wiz-workspace",
        "/wiz/{video_id}",
        "Ready to chat!",
        authenticated=True,
        dynamic_video=True,
        wiz_workspace=True,
    ),
}


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    try:
        result = int(value)
    except ValueError as error:
        raise RuntimeError(f"Invalid integer value for {name}: {value!r}") from error
    if result < 0:
        raise RuntimeError(f"{name} must not be negative.")
    return result


def build_runtime_config() -> RuntimeConfig:
    output_value = os.environ.get(
        "VIDWIZ_UI_IMAGE_OUTPUT_DIR", DEFAULT_OUTPUT_DIR
    ).strip()
    output_dir = Path(output_value)
    if not output_dir.is_absolute():
        output_dir = ROOT_DIR / output_dir

    return RuntimeConfig(
        ui_base_url=os.environ.get("VIDWIZ_UI_BASE_URL", DEFAULT_UI_BASE_URL).rstrip(
            "/"
        ),
        api_base_url=os.environ.get("VIDWIZ_API_BASE_URL", DEFAULT_API_BASE_URL).rstrip(
            "/"
        ),
        output_dir=output_dir,
        email=clean_optional_env("VIDWIZ_AUTOMATION_EMAIL"),
        password=clean_optional_env("VIDWIZ_AUTOMATION_PASSWORD"),
        video_id=clean_optional_env("VIDWIZ_AUTOMATION_VIDEO_ID"),
        navigation_timeout_ms=env_int(
            "VIDWIZ_AUTOMATION_NAVIGATION_TIMEOUT_MS", 30_000
        ),
        scroll_overlap_px=env_int("VIDWIZ_AUTOMATION_SCROLL_OVERLAP_PX", 140),
        post_scroll_settle_ms=env_int("VIDWIZ_AUTOMATION_POST_SCROLL_SETTLE_MS", 400),
        max_screenshots_per_page=env_int(
            "VIDWIZ_AUTOMATION_MAX_SCREENSHOTS_PER_PAGE", 20
        ),
    )


def clean_optional_env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Capture VidWiz pages as overlapping desktop or mobile screenshots."
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument(
        "--pages", nargs="+", metavar="PAGE", help="Page aliases to capture."
    )
    selection.add_argument(
        "--all", action="store_true", help="Capture every page alias."
    )
    parser.add_argument(
        "--sizes", nargs="+", metavar="SIZE", help="Viewport aliases to capture."
    )
    parser.add_argument(
        "--list", action="store_true", help="List available pages and sizes."
    )
    parser.add_argument(
        "--browser-mode",
        choices=("headless", "headful"),
        default="headless",
        help="Run Chromium hidden or visible (default: headless).",
    )
    return parser


def resolve_options(
    parser: argparse.ArgumentParser, args: argparse.Namespace
) -> CliOptions:
    if not args.all and not args.pages:
        parser.error("one of --pages or --all is required unless --list is used.")
    if not args.sizes:
        parser.error("--sizes is required unless --list is used.")

    page_aliases = list(PAGE_CAPTURES) if args.all else list(args.pages)
    size_aliases = list(args.sizes)
    unknown_pages = sorted(set(page_aliases) - PAGE_CAPTURES.keys())
    unknown_sizes = sorted(set(size_aliases) - VIEWPORT_PRESETS.keys())
    if unknown_pages:
        parser.error(
            f"unknown page alias(es): {', '.join(unknown_pages)}. Use --list for options."
        )
    if unknown_sizes:
        parser.error(
            f"unknown size alias(es): {', '.join(unknown_sizes)}. Use --list for options."
        )

    return CliOptions(
        pages=[PAGE_CAPTURES[alias] for alias in page_aliases],
        sizes=[VIEWPORT_PRESETS[alias] for alias in size_aliases],
        headless=args.browser_mode == "headless",
    )


def validate_config(config: RuntimeConfig, pages: Sequence[PageCapture]) -> None:
    if any(page.authenticated for page in pages):
        missing = []
        if not config.email:
            missing.append("VIDWIZ_AUTOMATION_EMAIL")
        if not config.password:
            missing.append("VIDWIZ_AUTOMATION_PASSWORD")
        if missing:
            raise RuntimeError(
                f"Missing required environment variable(s): {', '.join(missing)}"
            )

    if any(page.dynamic_video for page in pages) and not config.video_id:
        raise RuntimeError(
            "Missing required environment variable: VIDWIZ_AUTOMATION_VIDEO_ID"
        )
    if config.max_screenshots_per_page < 1:
        raise RuntimeError(
            "VIDWIZ_AUTOMATION_MAX_SCREENSHOTS_PER_PAGE must be at least 1."
        )


def print_available_options() -> None:
    print("Available pages:")
    for capture in PAGE_CAPTURES.values():
        path = capture.path.replace("{video_id}", "{VIDWIZ_AUTOMATION_VIDEO_ID}")
        labels = []
        if capture.authenticated:
            labels.append("authenticated")
        if capture.dynamic_video:
            labels.append("configured video")
        suffix = f" ({', '.join(labels)})" if labels else ""
        print(f"  - {capture.alias}: {path}{suffix}")

    print("\nAvailable sizes:")
    for preset in VIEWPORT_PRESETS.values():
        print(f"  - {preset.alias}: {preset.width}x{preset.height}")
    print("\nAvailable browser modes:\n  - headless\n  - headful")


def request_json(
    url: str, payload: dict[str, str], timeout_seconds: float
) -> dict[str, object]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Automation login failed with HTTP {error.code}: {detail}"
        ) from error
    except urllib.error.URLError as error:
        raise RuntimeError(
            f"Could not reach the VidWiz API at {url}: {error.reason}"
        ) from error
    except json.JSONDecodeError as error:
        raise RuntimeError("Automation login returned invalid JSON.") from error


def login(config: RuntimeConfig) -> str:
    if not config.email or not config.password:
        raise RuntimeError(
            "Automation credentials are required for authenticated captures."
        )
    result = request_json(
        f"{config.api_base_url}/auth/login",
        {"email": config.email, "password": config.password},
        config.navigation_timeout_ms / 1000,
    )
    token = result.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Automation login response did not contain a token.")
    return token


def build_context(
    browser: Browser,
    preset: ViewportPreset,
    token: str | None,
    config: RuntimeConfig,
) -> BrowserContext:
    context = browser.new_context(
        viewport={"width": preset.width, "height": preset.height},
        reduced_motion="reduce",
        color_scheme="dark",
    )
    context.set_default_timeout(config.navigation_timeout_ms)
    context.set_default_navigation_timeout(config.navigation_timeout_ms)
    context.add_init_script(build_init_script(token))
    return context


def build_init_script(token: str | None) -> str:
    token_json = json.dumps(token)
    return f"""
    (() => {{
      const token = {token_json};
      localStorage.setItem('theme', 'dark');
      sessionStorage.removeItem('guestSessionId');
      if (token) localStorage.setItem('token', token);
      else localStorage.removeItem('token');
      const installStyles = () => {{
        document.documentElement.classList.add('dark');
        const style = document.createElement('style');
        style.dataset.vidwizScreenshots = 'true';
        style.textContent = `
          *, *::before, *::after {{
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            transition-duration: 0s !important;
            scroll-behavior: auto !important;
            caret-color: transparent !important;
          }}
        `;
        document.head.appendChild(style);
      }};
      if (document.head) installStyles();
      else document.addEventListener('DOMContentLoaded', installStyles, {{ once: true }});
    }})();
    """


def capture_for_size(
    browser: Browser,
    preset: ViewportPreset,
    pages: Sequence[PageCapture],
    token: str | None,
    config: RuntimeConfig,
) -> None:
    anonymous_pages = [capture for capture in pages if not capture.authenticated]
    authenticated_pages = [capture for capture in pages if capture.authenticated]

    for captures, context_token in (
        (anonymous_pages, None),
        (authenticated_pages, token),
    ):
        if not captures:
            continue
        context = build_context(browser, preset, context_token, config)
        try:
            page = context.new_page()
            for capture in captures:
                capture_page(page, capture, preset, config)
        finally:
            context.close()


def capture_page(
    page: Page,
    capture: PageCapture,
    preset: ViewportPreset,
    config: RuntimeConfig,
) -> None:
    path = capture.path.format(video_id=config.video_id)
    url = f"{config.ui_base_url}{path}"
    base_name = f"{preset.alias}-{capture.alias}"
    requests: list[tuple[str, str]] = []
    responses: list[tuple[str, str, int]] = []

    def record_request(request) -> None:
        requests.append((request.method, request.url))

    def record_response(response: Response) -> None:
        responses.append((response.request.method, response.url, response.status))

    page.on("request", record_request)
    page.on("response", record_response)
    try:
        print(f"Capturing {url} [{preset.alias}] -> {base_name}-*.png")
        response = page.goto(url, wait_until="domcontentloaded")
        if response and response.status >= 400:
            raise RuntimeError(f"Navigation to {url} returned HTTP {response.status}.")

        wait_for_ready_state(page, capture, responses, config)
        assert_expected_route(page, capture, path)
        wait_for_visual_stability(page, config)
        reset_scroll(page, config)
        clear_existing_outputs(base_name, config.output_dir)
        capture_scrolled_sequence(page, base_name, config)

        message_posts = [
            request_url
            for method, request_url in requests
            if method == "POST"
            and "/conversations/" in request_url
            and request_url.endswith("/messages")
        ]
        if message_posts:
            raise RuntimeError(
                "The screenshot workflow unexpectedly submitted a Wiz message."
            )
    finally:
        page.remove_listener("request", record_request)
        page.remove_listener("response", record_response)


def wait_for_ready_state(
    page: Page,
    capture: PageCapture,
    responses: list[tuple[str, str, int]],
    config: RuntimeConfig,
) -> None:
    try:
        page.get_by_text(capture.ready_text, exact=False).first.wait_for(
            state="visible"
        )
        if capture.wiz_workspace:
            page.get_by_placeholder("Ask about this video...").wait_for(state="visible")
            wait_for_conversation_creation(
                page, responses, config.navigation_timeout_ms
            )
    except PlaywrightTimeoutError as error:
        raise RuntimeError(
            f"Timed out waiting for {capture.alias!r} to become ready at {page.url}."
        ) from error


def wait_for_conversation_creation(
    page: Page,
    responses: list[tuple[str, str, int]],
    timeout_ms: int,
) -> None:
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        conversation_responses = [
            status
            for method, url, status in responses
            if method == "POST"
            and urlparse(url).path.rstrip("/").endswith("/v2/conversations")
        ]
        if conversation_responses:
            status = conversation_responses[-1]
            if 200 <= status < 300:
                return
            raise RuntimeError(f"Wiz conversation creation failed with HTTP {status}.")
        page.wait_for_timeout(100)
    raise RuntimeError("Timed out waiting for the Wiz conversation to be created.")


def assert_expected_route(page: Page, capture: PageCapture, expected_path: str) -> None:
    actual_path = urlparse(page.url).path.rstrip("/") or "/"
    normalized_expected = expected_path.rstrip("/") or "/"
    if capture.authenticated and actual_path == "/login":
        raise RuntimeError(f"Navigation to {normalized_expected} redirected to login.")
    if actual_path != normalized_expected:
        raise RuntimeError(
            f"Navigation to {normalized_expected} ended at unexpected route {actual_path}."
        )


def wait_for_visual_stability(page: Page, config: RuntimeConfig) -> None:
    page.evaluate("() => document.fonts?.ready || Promise.resolve()")
    page.evaluate(
        """
        (timeoutMs) => Promise.race([
          Promise.all(Array.from(document.images).map((image) => {
            if (image.complete) return Promise.resolve();
            return new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            });
          })),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ])
        """,
        min(config.navigation_timeout_ms, 5_000),
    )
    page.wait_for_timeout(config.post_scroll_settle_ms)


def reset_scroll(page: Page, config: RuntimeConfig) -> None:
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(config.post_scroll_settle_ms)


def clear_existing_outputs(base_name: str, output_dir: Path) -> None:
    for path in output_dir.glob(f"{base_name}-*.png"):
        path.unlink()


def capture_scrolled_sequence(
    page: Page, base_name: str, config: RuntimeConfig
) -> None:
    previous_scroll_y = -1
    for index in range(1, config.max_screenshots_per_page + 1):
        output_path = config.output_dir / f"{base_name}-{index:02d}.png"
        page.screenshot(path=str(output_path), full_page=False)
        metrics = page.evaluate(
            """
            () => ({
              scrollY: Math.round(window.scrollY),
              viewportHeight: Math.round(window.innerHeight),
              scrollHeight: Math.round(document.documentElement.scrollHeight),
            })
            """
        )
        scroll_y = metrics["scrollY"]
        viewport_height = metrics["viewportHeight"]
        max_scroll_y = max(0, metrics["scrollHeight"] - viewport_height)
        if scroll_y >= max_scroll_y:
            return

        scroll_step = max(1, viewport_height - config.scroll_overlap_px)
        next_scroll_y = min(max_scroll_y, scroll_y + scroll_step)
        if next_scroll_y <= scroll_y or next_scroll_y == previous_scroll_y:
            return

        previous_scroll_y = scroll_y
        page.evaluate("(nextY) => window.scrollTo(0, nextY)", next_scroll_y)
        page.wait_for_timeout(config.post_scroll_settle_ms)

    raise RuntimeError(f"Exceeded screenshot guard for {base_name}.")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.list:
        print_available_options()
        return 0

    try:
        options = resolve_options(parser, args)
        config = build_runtime_config()
        validate_config(config, options.pages)
        config.output_dir.mkdir(parents=True, exist_ok=True)
        token = (
            login(config) if any(page.authenticated for page in options.pages) else None
        )

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=options.headless)
            try:
                for preset in options.sizes:
                    capture_for_size(browser, preset, options.pages, token, config)
            finally:
                browser.close()
    except (RuntimeError, PlaywrightError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
