from flask import Flask, jsonify, request, render_template, send_file
from flask_cors import CORS
import dao.notes_dao as notes_dao
import services as services

app = Flask(__name__)
CORS(app)


@app.route('/')
def hello_world():
    return jsonify({'message': 'Hello, World!, YT Notes Extension Server'})


@app.route('/saveNotes', methods=['POST'])
def save_notes():
    try:
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

        return jsonify({'task': 'save_notes', 'status': 'success'})
    except Exception as e:
        print(e)
        return jsonify({'task': 'save_notes', 'status': 'failure'})


@app.route('/viewNotes', methods=['GET'])
def get_notes():
    try:
        url = request.args.get('video_url')

        video_id = notes_dao.get_video_id(url)
        notes = notes_dao.get_notes(video_id)

        md_string = services.create_markdown_string(video_id, notes)
        html_content = services.markdown_to_html(md_string)

        return render_template('notes.html', content=html_content)
    except Exception as e:
        print(e)
        return jsonify({'task': 'view_notes', 'status': 'failure'})


@app.route('/getMD', methods=['GET'])
def get_md():
    try:
        url = request.args.get('video_url')

        video_id = notes_dao.get_video_id(url)
        notes = notes_dao.get_notes(video_id)

        # check if notes exist
        if len(notes['general_notes']) == 0 and len(notes['timestamp_notes']) == 0:
            return jsonify({'task': 'get_MD', 'status': 'failure'})

        md_string = services.create_markdown_string(video_id, notes)
        filepath = services.create_markdown_file(md_string, video_id)

        return send_file(filepath, as_attachment=True)

    except Exception as e:
        print(e)
        return jsonify({'task': 'get_MD', 'status': 'failure'})


@app.route('/checkNotesExist', methods=['POST'])
def check_notes_exist():
    try:
        data = request.get_json()
        url = services.clean_yt_url(data.get('url'))

        video_id = notes_dao.get_video_id(url)
        notes = notes_dao.get_notes(video_id)

        # check if notes exist
        if len(notes['general_notes']) == 0 and len(notes['timestamp_notes']) == 0:
            return jsonify({'task': 'get_MD', 'status': 'success', 'exists': False})
        else:
            return jsonify({'task': 'get_MD', 'status': 'success', 'exists': True})

    except Exception as e:
        print(e)
        return jsonify({'task': 'check_notes_exist', 'status': 'failure'})
    
    
@app.route('/getGeneralNotes', methods=['POST'])
def fetch_general_notes():
    try:
        data = request.get_json()
        url = services.clean_yt_url(data.get('url'))

        video_id = notes_dao.get_video_id(url)
        notes = notes_dao.get_notes(video_id)

        general_notes = notes['general_notes']
        general_notes_strings = [x[1] for x in general_notes]
        if len(general_notes_strings) == 0:
            return jsonify({'task': 'get_general_notes', 'status': 'success', 'exists': False})
        else:
            return jsonify({'task': 'get_general_notes', 'status': 'success', 'exists': True, 'notes': general_notes_strings})
    except Exception as e:
        print(e)
        return jsonify({'task': 'check_notes_exist', 'status': 'failure', 'exists': False})


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000)
