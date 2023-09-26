# add flask boilerplate
from flask import Flask, jsonify, request, render_template
from flask_cors import CORS
import dao.notes_dao as notes_dao
import services as services

app = Flask(__name__)
CORS(app)


@app.route('/')
def hello_world():
    return jsonify({'message': 'Hello, World!'})


@app.route('/saveNotes', methods=['POST'])
def save_notes():
    data = request.get_json()

    url = data.get('url')
    title = data.get('videoTitle')
    timestamp = data.get('videoTimestamp')
    general_notes = data.get('generalNotes')
    timestamp_notes = data.get('timestampNotes')

    url = services.clean_yt_url(url)

    # check if the video exists in the database
    if not notes_dao.check_video_exists(url):
        video_id = notes_dao.insert_video(url, title)
    else:
        video_id = notes_dao.get_video_id(url)

    if len(general_notes) == 0:
        notes_dao.insert_timestamp_note(video_id, timestamp, timestamp_notes)
    elif len(timestamp_notes) != 0 and len(general_notes) != 0:
        notes_dao.insert_general_note(video_id, general_notes)
        notes_dao.insert_timestamp_note(video_id, timestamp, timestamp_notes)
    else:
        notes_dao.insert_general_note(video_id, general_notes)

    return jsonify({'success': True})


@app.route('/viewNotes', methods=['GET'])
def get_file():
    url = request.args.get('video_url')

    video_id = notes_dao.get_video_id(url)
    notes = notes_dao.get_notes(video_id)

    md_string = services.create_markdown(video_id, notes)
    html_content = services.markdown_to_html(md_string)

    return render_template('notes.html', content=html_content)


@app.route('/getNotes', methods=['GET'])
def get_notes():
    url = request.args.get('video_url')

    video_id = notes_dao.get_video_id(url)
    notes = notes_dao.get_notes(video_id)

    return jsonify({'notes': notes})


if __name__ == "__main__":
    app.run(debug=True)
