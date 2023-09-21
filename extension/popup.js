function fetchVideoTitle() {
    if (window.location.hostname === 'www.youtube.com' && window.location.pathname === '/watch') {
        const titleElement = document.querySelector('.title.style-scope.ytd-video-primary-info-renderer');
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
    if (window.location.hostname === 'www.youtube.com' && window.location.pathname === '/watch') {
        const timestampElement = document.querySelector("#movie_player > div.ytp-chrome-bottom > div.ytp-chrome-controls > div.ytp-left-controls > div.ytp-time-display.notranslate > span:nth-child(2) > span.ytp-time-current");
        if (timestampElement) {
            return (timestampElement.textContent);
        } else {
            return 'Timestamp element not found.';
        }
    } else {
        return 'Not on a YouTube video page.';
    }
}


function saveNotesToBackend(url, generalNotes, timestampNotes, videoTitle, videoTimestamp) {
    // Check if a YouTube video is found
    if (videoTitle === 'No YouTube video found.') {
        setMessage('No YouTube video found on this page. Notes not saved.');
        return; // Exit the function early
    }

    // Define the API endpoint (replace with your actual endpoint)
    const apiEndpoint = "http://127.0.0.1:5000/saveNotes";

    // Prepare the data to be sent
    const data = {
        url: url,
        videoTitle: videoTitle,
        videoTimestamp: videoTimestamp,
        generalNotes: generalNotes,
        timestampNotes: timestampNotes
    };

    console.log("Sending data:", data);

    // Make the API call
    fetch(apiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            setMessage('Notes saved successfully!');
        } else {
            setMessage('Failed to save notes.');
        }
    })
    .catch(error => {
        console.error('Error saving notes:', error);
        setMessage('Error saving notes. Please try again.');
    });
}

function setMessage(message) {
    document.getElementById('message-area').textContent = message;
}

document.addEventListener('DOMContentLoaded', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const tabId = tabs[0].id;
        const tabURL = tabs[0].url;

        chrome.scripting.executeScript({
            target: {tabId: tabId},
            function: fetchVideoTitle
        }, function(results) {
            if (results && results[0]) {
                document.getElementById('video-title').textContent = results[0].result;
            }
        });

        chrome.scripting.executeScript({
            target: {tabId: tabId},
            function: fetchVideoTimestamp
        }, function(results) {
            if (results && results[0]) {
                document.getElementById('current-timestamp').textContent = results[0].result;
            }
        });
    });
});

document.getElementById('saveNotesBtn').addEventListener('click', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const tabURL = tabs[0].url;

        chrome.scripting.executeScript({
            target: {tabId: tabs[0].id},
            function: fetchVideoTitle
        }, function(titleResults) {
            chrome.scripting.executeScript({
                target: {tabId: tabs[0].id},
                function: fetchVideoTimestamp
            }, function(timestampResults) {
                const generalNotes = document.getElementById('general-notes-textarea').value;
                const timestampNotes = document.getElementById('timestamp-notes-textarea').value;


                saveNotesToBackend(tabURL, generalNotes, timestampNotes, titleResults[0].result, timestampResults[0].result);
            });
        });
    });
});

document.getElementById('viewData').addEventListener('click', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const tabURL = tabs[0].url;
        const viewNotesURL = `http://127.0.0.1:5000/viewNotes?video_url=${tabURL}`;
        chrome.tabs.create({ url: viewNotesURL });
    });
});