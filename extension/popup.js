const backendEndpoint = "http://127.0.0.1:5000/"  //http://192.168.29.181:5010/

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
    if (videoTitle === 'No YouTube video found.') {
        setMessage('No YouTube video found on this page. Notes not saved.');
        return;
    }

    const apiEndpoint = backendEndpoint + "saveNotes";

    const notesData = {
        url: url,
        videoTitle: videoTitle,
        videoTimestamp: videoTimestamp,
        generalNotes: generalNotes,
        timestampNotes: timestampNotes
    };

    fetch(apiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(notesData)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            setMessage('Notes saved successfully!', 'green');
        } else {
            setMessage('Failed to save notes.', 'red');
        }
    })
    .catch(error => {
        console.error('Error saving notes:', error);
        setMessage('Error saving notes. Unable to communicate with server.', 'red');
    });
}

function checkNotesExistence(url) {
    const apiEndpoint = backendEndpoint + "checkNotesExist";

    const videoData = {
        url: url,
    };

    return fetch(apiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(videoData)
    })
    .then(response => response.json())
    .then(data => {
        if (data['exists'] === true) {
            return 1
        } else {
            return 0
        }
    })
    .catch(error => {
        console.error('Error checking notes:', error);
        setMessage('Error checking notes. Unable to communicate with server.', 'red');
    });
}

function setMessage(message, color) {
    document.getElementById('message-area').textContent = message;
    document.getElementById('message-area').style.color = color || 'black';
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
    
    var generalNotes = getGeneralNotes(tabURL);
    generalNotes.then(function(result) {
        if (result !== -1) {
            document.getElementById('general-notes-textarea').placeholder = result;
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
        checkNotesExistence(tabURL).then(notesExist => {
            if (notesExist) {
                const viewNotesURL = backendEndpoint + "viewNotes?video_url=" + tabURL;
                chrome.tabs.create({ url: viewNotesURL });
            }
            else {
                setMessage('No notes found for this video.', 'red');
            }
        }).catch(error => {
            console.error('Error:', error);
            setMessage('Error occurred while checking for notes.', 'red');
        });
    });
});

document.getElementById('downloadMD').addEventListener('click', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const tabURL = tabs[0].url;
        checkNotesExistence(tabURL).then(notesExist => {
            if (notesExist) {
                const MDFileUrl = backendEndpoint + "getMD?video_url=" + tabURL;
                chrome.tabs.create({ url: MDFileUrl });
            }
            else {
                setMessage('No notes found for this video.', 'red');
            }
        }).catch(error => {
            console.error('Error:', error);
            setMessage('Error occurred while checking for notes.', 'red');
        });



    });
});

function getGeneralNotes(url) {
    const apiEndpoint = backendEndpoint + "getGeneralNotes";

    const videoData = {
        url: url,
    };

    return fetch(apiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(videoData)
    })
    .then(response => response.json())
    .then(data => {
        if (data['exists'] === true) {
            return data['notes']
        } else {
            return -1
        }
    })
    .catch(error => {
        console.error('Error fetching general notes:', error);
        setMessage('Error checking notes. Unable to communicate with server.', 'red');
        return -1
    });
}