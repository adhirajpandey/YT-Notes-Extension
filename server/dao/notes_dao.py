import sqlite3
import datetime

# DATABASE = "server/database/notes.db"
DATABASE = r"C:\Users\Adhiraj\PycharmProjects\YT-Marker\server\database\notes.db"


def get_current_timestamp():
    return round(datetime.datetime.now().timestamp(), 2)


def create_connection(db_file):
    """ create a database connection to a SQLite database """
    conn = sqlite3.connect(db_file)
    return conn


def check_video_exists(url):
    conn = create_connection(DATABASE)
    c = conn.cursor()
    c.execute('''
    SELECT * FROM videos WHERE video_url = ?
    ''', (url,))
    data = c.fetchall()
    conn.close()
    return len(data) > 0


def insert_video(url, title):
    conn = create_connection(DATABASE)
    c = conn.cursor()
    videos_table_name = 'videos'
    created_at = get_current_timestamp()

    c.execute(f'''
    INSERT INTO {videos_table_name} (video_url, video_title, created_at) VALUES (?, ?, ?)
    ''', (url, title, created_at))
    conn.commit()

    # Get the video id of the inserted video
    c.execute(f'''
    SELECT id FROM {videos_table_name} WHERE video_url = ?
    ''', (url,))
    video_id = c.fetchone()[0]

    conn.close()
    return video_id


def get_video_id(url):
    conn = create_connection(DATABASE)
    c = conn.cursor()
    videos_table_name = 'videos'

    c.execute(f'''
    SELECT id FROM {videos_table_name} WHERE video_url = ?
    ''', (url,))
    video_id = c.fetchone()[0]

    conn.close()
    return video_id


def insert_timestamp_note(video_id, timestamp, timestamp_notes):
    conn = create_connection(DATABASE)
    c = conn.cursor()
    timestamp_notes_table_name = 'timestamp_notes'
    created_at = get_current_timestamp()

    c.execute(f'''
    INSERT INTO {timestamp_notes_table_name} (timestamp, note, video_id, created_at) VALUES (?, ?, ?, ?)
    ''', (timestamp, timestamp_notes, video_id, created_at))
    conn.commit()
    conn.close()


def insert_general_note(video_id, general_notes):
    conn = create_connection(DATABASE)
    c = conn.cursor()
    general_notes_table_name = 'general_notes'
    created_at = get_current_timestamp()

    c.execute(f'''
    INSERT INTO {general_notes_table_name} (note, video_id, created_at) VALUES (?, ?, ?)
    ''', (general_notes, video_id, created_at))
    conn.commit()
    conn.close()

# insert_timestamp_note('test', 'test', 3)
# insert_general_note('test', 3)
# print(fetchalldata('test', 'test', 'test', 'test'))
# print(insert_video('test', 'test'))
