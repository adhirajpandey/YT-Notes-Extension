# YT-Notes-Extension

## Description
Chrome Extension that simplifies note-taking for both general purposes and specific timestamps in YouTube videos. Unlike other note-taking tools, this extension prioritizes your privacy by being self-hosted.

## Features
1. General Notes: Easily jot down your thoughts, ideas, or any information with the general notes feature. Keep your thoughts organized and accessible whenever you need them.

2. Timestamped Notes: Enhance your video-watching experience by adding timestamped notes for specific moments in YouTube videos. Never lose track of valuable information again.

3. Self-Hosted: This extension operates on a self-hosted model, ensuring that your notes stay confidential and are not stored on external servers.

4. MD File Download: Effortlessly download Markdown (MD) files for individual videos, encompassing both General and Timestamped Notes

## Installation

### To Setup Backend
1. Clone the project to your local system using: `git clone https://github.com/adhirajpandey/YT-Notes-Extension`

2. Build Backend server image using: `docker build -t yt_notes .`

3. Setup Docker container using: `docker run -d -p 5000:5000 --name yt_notes_backend yt_notes`

### To Setup Chrome Extension in Browser
1. Open Chrome on your machine and navigate to: `chrome://extensions/`

2. Ensure the "Developer mode" checkbox in the top-right corner is checked.

3. Click on Load Unpacked Extension Button, navigate to the `extension` folder in your cloned repository and select it.

## Sample
![ui](https://github.com/adhirajpandey/YT-Notes-Extension/assets/87516052/adbd29ba-78e0-4002-bc6f-69b3a50e8d2a)



