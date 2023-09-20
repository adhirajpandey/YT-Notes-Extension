document.addEventListener('DOMContentLoaded', function() {
    // Get the current tab's ID
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const tabId = tabs[0].id;

        fetchVideoTitle();
        fetchVideoTimestamp();
    });
});

function fetchVideoTitle() {
    // Check if the current URL is a YouTube video page
    if (window.location.hostname === 'www.youtube.com' && window.location.pathname === '/watch') {
        // Try to fetch the video title element
        const titleElement = document.querySelector('.title.style-scope.ytd-video-primary-info-renderer');

        // If the title element is found, return the title
        if (titleElement) {
            return titleElement.textContent.trim();
        } else {
            return 'No YouTube video title found.';
        }
    } else {
        return 'No YouTube video found.';
    }
}

function fetchVideoTimestamp() {
    // Check if the current URL is a YouTube video page
    if (window.location.hostname === 'www.youtube.com' && window.location.pathname === '/watch') {
        // Use the provided selector to fetch the current timestamp element
        const timestampElement = document.querySelector("#movie_player > div.ytp-chrome-bottom > div.ytp-chrome-controls > div.ytp-left-controls > div.ytp-time-display.notranslate > span:nth-child(2) > span.ytp-time-current");

        // If the timestamp element is found, print the timestamp
        if (timestampElement) {
            return (`Current timestamp: ${timestampElement.textContent}`);
        } else {
            return ('Timestamp element not found.');
        }
    } else {
        return ('Not on a YouTube video page.');
    }
}
