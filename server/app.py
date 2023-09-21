# add flask boilerplate
from flask import Flask, jsonify, request
from flask_cors import CORS
import dao.notes_dao as notes_dao

app = Flask(__name__)
CORS(app)


@app.route('/')
def hello_world():
    return jsonify({'message': 'Hello, World!'})


# add a route
@app.route('/saveNotes', methods=['POST'])
def save_notes():
    # print the input data
    data = request.get_json()
    url = data.get('url')
    title = data.get('videoTitle')
    timestamp = data.get('videoTimestamp')
    general_notes = data.get('generalNotes')
    timestamp_notes = data.get('timestampNotes')

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
    # return a success response
    return jsonify({'success': True})


# run the Flask app
if __name__ == "__main__":
    app.run(debug=True)
