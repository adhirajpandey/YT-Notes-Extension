import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { FaExternalLinkAlt } from 'react-icons/fa';
import { extractVideoId } from '../lib/videoUtils';
import GuestLimitModal from '../components/GuestLimitModal';
import RegisteredLimitModal from '../components/RegisteredLimitModal';
import Seo from '../components/Seo';
import ErrorState from '../components/ui/ErrorState';
import { getToken } from '../lib/authUtils';
import {
  apiFetch,
  normalizeFetchError,
  readSseEvents,
  videosApi,
} from '../api';
import type { NormalizedApiError } from '../api/errors';
import { useWizChat } from '../hooks/useWizChat';
import WizChat from '../components/wiz/WizChat';

interface VideoData {
  video_id: string;
  title: string | null;
  transcript_available: boolean;
  metadata: {
    title?: string;
    channel?: string;
    channel_url?: string;
    uploader?: string;
    uploader_url?: string;
    duration_string?: string;
    thumbnail?: string;
    view_count?: number;
    like_count?: number;
    upload_date?: string;
  } | null;
  summary: string | null;
  suggested_questions?: string[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVideoData(value: unknown): value is VideoData {
  if (!isRecord(value)) return false;
  const suggestedQuestions = value.suggested_questions;
  return (
    typeof value.video_id === 'string' &&
    (value.title === null || typeof value.title === 'string') &&
    typeof value.transcript_available === 'boolean' &&
    (value.metadata === null || isRecord(value.metadata)) &&
    (value.summary === null || typeof value.summary === 'string') &&
    (
      suggestedQuestions === null ||
      suggestedQuestions === undefined ||
      (
        Array.isArray(suggestedQuestions) &&
        suggestedQuestions.every((question) => typeof question === 'string')
      )
    )
  );
}

function parseJsonPayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('The server returned an invalid stream response.');
  }
}

function WizWorkspacePage() {
  const params = useParams();
  const location = useLocation();
  
  // Reconstruct full input by adding query params back to the path
  const rawInput = (params['*'] || '') + location.search;
  const videoId = extractVideoId(rawInput);
  
  const navigate = useNavigate();

  const [videoData, setVideoData] = useState<VideoData | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [showRefreshModal, setShowRefreshModal] = useState(false);
  const [statusError, setStatusError] = useState<NormalizedApiError | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const playerRef = useRef<HTMLIFrameElement>(null);
  const pollingStartTime = useRef<number>(Date.now());
  const videoDataRef = useRef<VideoData | null>(null);

  // Handle URL normalization and redirects
  useEffect(() => {
    if (!rawInput) {
      navigate('/wiz', { replace: true });
      return;
    }
    
    // If extraction failed or returned null
    if (!videoId) {
      // Invalid ID or URL
      navigate('/wiz', { replace: true });
      return;
    }

    // If the raw input is different from the clean ID (e.g. it was a full URL),
    // redirect to the clean ID version
    if (videoId !== rawInput) {
      navigate(`/wiz/${videoId}`, { replace: true });
    }
  }, [rawInput, videoId, navigate]);

  // Reset state when videoId changes
  useEffect(() => {
    setVideoData(null);
    setIsPolling(true);
    setShowRefreshModal(false);
    setStatusError(null);
    // Reset refs
    pollingStartTime.current = Date.now();
  }, [videoId]);

  // Computed status
  const transcriptStatus = videoData?.transcript_available ? 'ready' : 'loading';
  const chat = useWizChat(videoId, transcriptStatus === 'ready');

  useEffect(() => {
    videoDataRef.current = videoData;
  }, [videoData]);

  // Stream video status via SSE and reconnect within the existing deadline.
  useEffect(() => {
    if (!videoId) return;
    const activeVideoId = videoId;

    const STREAM_TIMEOUT_MS = 60000;
    const RECONNECT_DELAY_MS = 5000;
    let isCancelled = false;
    let abortController: AbortController | null = null;
    let timeoutId: number | undefined;
    let reconnectId: number | undefined;
    let hasTimedOut = false;
    let hasSuccessfulStatusCheck = false;
    let lastStatusError: NormalizedApiError | null = null;
    let lastAttemptFailed = false;

    const handleTimeout = () => {
      hasTimedOut = true;
      setIsPolling(false);
      if (!videoDataRef.current?.transcript_available) {
        if (
          lastStatusError &&
          (!hasSuccessfulStatusCheck || lastAttemptFailed)
        ) {
          setStatusError(lastStatusError);
        } else {
          setShowRefreshModal(true);
        }
      }
      if (abortController) {
        abortController.abort();
      }
      if (reconnectId) {
        clearTimeout(reconnectId);
      }
    };

    const scheduleReconnect = () => {
      if (isCancelled || hasTimedOut || reconnectId) return;
      const remaining =
        STREAM_TIMEOUT_MS - (Date.now() - pollingStartTime.current);
      if (remaining <= 0) {
        handleTimeout();
        return;
      }
      reconnectId = window.setTimeout(() => {
        reconnectId = undefined;
        void startStream();
      }, Math.min(RECONNECT_DELAY_MS, remaining));
    };

    async function startStream() {
      if (isCancelled || hasTimedOut) return;
      setIsPolling(true);
      setStatusError(null);

      // Ensure guest session id exists for unauthenticated users
      const token = getToken();
      if (!token && !sessionStorage.getItem('guestSessionId')) {
        sessionStorage.setItem('guestSessionId', crypto.randomUUID());
      }

      abortController = new AbortController();

      try {
        const response = await apiFetch(videosApi.getStreamUrl(activeVideoId), {
          method: 'GET',
          signal: abortController.signal,
        });

        if (response.status === 401) {
          if (token) {
            if (timeoutId) clearTimeout(timeoutId);
            setIsPolling(false);
            return;
          }
          lastStatusError = await normalizeFetchError(
            response,
            'Unable to check the video status. Please try again.'
          );
          lastAttemptFailed = true;
          scheduleReconnect();
          return;
        }

        if (!response.ok) {
          lastStatusError = await normalizeFetchError(
            response,
            'Unable to check the video status. Please try again.'
          );
          throw new Error('Video status stream unavailable');
        }
        if (!response.body) {
          lastStatusError = {
            message: 'Unable to read the video status. Please try again.',
            kind: 'stream',
            retryable: true,
          };
          throw new Error('Video status stream unavailable');
        }

        lastAttemptFailed = false;
        for await (const event of readSseEvents(response.body)) {
          if (isCancelled) return;
          const payload = parseJsonPayload(event.data);
          if (
            !isRecord(payload) ||
            !isVideoData(payload.video)
          ) {
            throw new Error('The server returned an invalid video status.');
          }
          hasSuccessfulStatusCheck = true;
          lastStatusError = null;
          lastAttemptFailed = false;
          setStatusError(null);
          setVideoData(payload.video);
          if (event.event === 'done') {
            setIsPolling(false);
            if (timeoutId) clearTimeout(timeoutId);
            return;
          }
        }
        if (!isCancelled && !hasTimedOut) {
          lastStatusError = {
            message: 'The video status connection ended unexpectedly.',
            kind: 'stream',
            retryable: true,
          };
          lastAttemptFailed = true;
          scheduleReconnect();
        }
      } catch (error) {
        if (!isCancelled && !hasTimedOut) {
          if (!lastStatusError && !(error instanceof DOMException && error.name === 'AbortError')) {
            lastStatusError = {
              message: 'Unable to check the video status. Please try again.',
              kind: 'stream',
              retryable: true,
            };
          }
          lastAttemptFailed = true;
          console.error('Video status stream error:', error);
          scheduleReconnect();
        }
      }
    }

    const remaining =
      STREAM_TIMEOUT_MS - (Date.now() - pollingStartTime.current);
    if (remaining <= 0) {
      handleTimeout();
    } else {
      timeoutId = window.setTimeout(handleTimeout, remaining);
      void startStream();
    }

    return () => {
      isCancelled = true;
      if (abortController) {
        abortController.abort();
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (reconnectId) {
        clearTimeout(reconnectId);
      }
    };
  }, [statusAttempt, videoId]);

  const seekToTimestamp = (seconds: number) => {
    // Scroll video into view (especially for mobile)
    playerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (playerRef.current?.contentWindow) {
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({
          event: 'command',
          func: 'seekTo',
          args: [seconds, true],
        }),
        '*'
      );
    }
  };

  const retryVideoStatus = () => {
    chat.dismissProcessing();
    setShowRefreshModal(false);
    setStatusError(null);
    pollingStartTime.current = Date.now();
    setStatusAttempt((attempt) => attempt + 1);
  };

  const seoVideoTitleRaw = videoData?.title || videoData?.metadata?.title || 'this YouTube video';
  const seoVideoTitle =
    seoVideoTitleRaw.length > 32 ? `${seoVideoTitleRaw.slice(0, 32).trim()}..` : seoVideoTitleRaw;
  const seoTitle = `Wiz: Chat with ${seoVideoTitle} | VidWiz`;
  const seoDescription = `Ask, don’t scrub. Chat with this YouTube video in Wiz using transcript-grounded answers and clickable timestamp citations.`;

  return (
    <>
      <Seo
        key={seoTitle}
        title={seoTitle}
        description={seoDescription}
        path={videoId ? `/wiz/${videoId}` : '/wiz'}
        ogImage="https://vidwiz.online/og-wiz.png"
        noIndex
      />
      <div className="max-w-screen-2xl mx-auto px-4 md:px-6 py-5">
      {/* Refresh Modal */}
      {(showRefreshModal || chat.isProcessing) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 max-w-md w-full mx-4 border border-border shadow-2xl">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-orange-500/10 flex items-center justify-center">
                <svg className="w-8 h-8 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">Transcript still processing</h3>
              <p className="text-sm text-foreground/60 mb-6">
                Wiz needs a little more time to prepare this video. Check again
                without leaving the conversation.
              </p>
              <button
                onClick={retryVideoStatus}
                className="w-full px-4 py-3 bg-gradient-to-r from-violet-600 to-violet-500 hover:from-violet-500 hover:to-violet-400 text-white font-semibold rounded-xl transition-all"
              >
                Check again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Guest Limit Modal */}
      <GuestLimitModal 
        isOpen={chat.limit?.kind === 'guest'}
        onClose={chat.dismissLimit}
      />

      {/* Registered User Limit Modal */}
      <RegisteredLimitModal
        isOpen={chat.limit?.kind === 'user'}
        onClose={chat.dismissLimit}
        resetInSeconds={chat.limit?.resetSeconds ?? null}
      />

      {/* Main Content - Split View: Chat Left, Video Right */}
      <div className="flex flex-col-reverse lg:flex-row lg:items-stretch gap-6 lg:h-[calc(100vh-6.5rem)]">
        
        <WizChat
          key={`${videoId}-${chat.generation}`}
          chat={chat}
          isReady={transcriptStatus === 'ready'}
          suggestedQuestions={videoData?.suggested_questions}
          onSeek={seekToTimestamp}
          statusBanner={statusError ? (
            <div className="border-b border-border">
              <ErrorState compact className="py-5" title="Unable to check video status"
                message={statusError.message} referenceId={statusError.requestId} onRetry={retryVideoStatus} />
            </div>
          ) : transcriptStatus === 'loading' ? (
            <div role="status" className="flex items-center justify-center gap-3 px-4 py-3 bg-violet-500/10 border-b border-border">
              <div className="size-4 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
              <span className="text-sm wiz-accent-text">Preparing transcript...</span>
            </div>
          ) : null}
        />

        {/* Right Pane - Video + Details */}
        <div className="w-full lg:w-[55%] flex flex-col rounded-2xl bg-card border border-border overflow-hidden">
          {/* Video Player */}
          <div className="relative w-full bg-black flex-shrink-0">
            <div className="aspect-video">
              <iframe
                ref={playerRef}
                src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1`}
                title="YouTube video player"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="absolute inset-0 w-full h-full"
              />
            </div>
          </div>

          {/* Scrollable Content Area */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Video Title & Channel */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-3 flex-1 min-w-0">
                {videoData?.metadata ? (
                  <>
                    <h2 className="text-xl font-bold text-foreground leading-tight">
                      {videoData.title || videoData.metadata.title || 'Untitled Video'}
                    </h2>
                    {/* Channel badge - same style as VideoPage */}
                    <div className="flex flex-wrap items-center gap-2.5">
                      {(videoData.metadata.channel || videoData.metadata.uploader) && (
                        (videoData.metadata.channel_url || videoData.metadata.uploader_url) ? (
                          <a 
                            href={videoData.metadata.channel_url || videoData.metadata.uploader_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-red-500/20 to-red-600/10 text-red-400 border border-red-500/20 hover:from-red-500/30 hover:to-red-600/20 hover:border-red-500/30 transition-all duration-200 cursor-pointer"
                          >
                            {videoData.metadata.channel || videoData.metadata.uploader}
                            <FaExternalLinkAlt className="w-2.5 h-2.5 ml-1.5 opacity-60" />
                          </a>
                        ) : (
                          <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-red-500/20 to-red-600/10 text-red-400 border border-red-500/20 select-none">
                            {videoData.metadata.channel || videoData.metadata.uploader}
                          </span>
                        )
                      )}
                      {videoData.metadata.duration_string && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-sm text-foreground/60 bg-muted/50 border border-border">{videoData.metadata.duration_string}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="h-7 w-3/4 bg-muted rounded-lg animate-pulse" />
                    <div className="h-5 w-1/2 bg-muted rounded-lg animate-pulse" />
                  </>
                )}
              </div>
            </div>

            {/* Metadata Stats - Modern SaaS style */}
            <div className="flex flex-wrap items-center gap-2.5">
              {videoData?.metadata ? (
                <>
                  {typeof videoData.metadata.view_count === 'number' && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/50 border border-border">
                      <svg className="w-3.5 h-3.5 text-foreground/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      <span className="text-sm font-medium text-foreground/70">
                        {videoData.metadata.view_count.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {typeof videoData.metadata.like_count === 'number' && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/50 border border-border">
                      <svg className="w-3.5 h-3.5 text-foreground/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                      <span className="text-sm font-medium text-foreground/70">
                        {videoData.metadata.like_count.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {videoData.metadata.upload_date && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/50 border border-border">
                      <svg className="w-3.5 h-3.5 text-foreground/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span className="text-sm font-medium text-foreground/70">
                        {(() => {
                          // Format YYYYMMDD to readable date
                          const d = videoData.metadata.upload_date;
                          if (d && d.length === 8) {
                            const year = d.slice(0, 4);
                            const month = d.slice(4, 6);
                            const day = d.slice(6, 8);
                            return new Date(`${year}-${month}-${day}`).toLocaleDateString('en-US', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            });
                          }
                          return d;
                        })()}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex gap-3">
                  <div className="h-7 w-20 bg-muted rounded-lg animate-pulse" />
                  <div className="h-7 w-16 bg-muted rounded-lg animate-pulse" />
                  <div className="h-7 w-24 bg-muted rounded-lg animate-pulse" />
                </div>
              )}
            </div>

            {/* AI Summary */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-violet-400" />
                <span className="text-sm font-medium text-foreground/80">AI Summary</span>
              </div>
              {videoData?.summary ? (
                <p className="text-sm text-foreground/60 leading-relaxed">
                  {videoData.summary}
                </p>
              ) : isPolling ? (
                <div className="space-y-2.5">
                  <div className="h-4 w-full bg-muted rounded animate-pulse" />
                  <div className="h-4 w-full bg-muted rounded animate-pulse" />
                  <div className="h-4 w-full bg-muted rounded animate-pulse" />
                  <div className="h-4 w-full bg-muted rounded animate-pulse" />
                </div>
              ) : (
                <p className="text-sm text-foreground/50 italic">No summary available for this video.</p>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

export default WizWorkspacePage;
