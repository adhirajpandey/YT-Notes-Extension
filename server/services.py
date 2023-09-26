import datetime
import markdown
import dao.notes_dao as notes_dao


def clean_yt_url(url):
    if "&" in url:
        baseurl = url.split("&")[0]
    else:
        baseurl = url
    return baseurl


def epoch_to_datetime(epoch):
    return datetime.datetime.fromtimestamp(epoch).strftime('%Y-%m-%d %H:%M:%S')


def timestamp_in_seconds(timestamp):
    timestamp = timestamp.split(':')
    timestamp = list(map(int, timestamp))

    if len(timestamp) == 2:
        return timestamp[0] * 60 + timestamp[1]
    elif len(timestamp) == 3:
        return timestamp[0] * 3600 + timestamp[1] * 60 + timestamp[2]
    else:
        return -1


def create_markdown_string(video_id, notes):
    general_notes = notes['general_notes']
    timestamp_notes = notes['timestamp_notes']

    video_title, video_url = notes_dao.get_video_title_and_url(video_id)

    markdown_string = ''

    markdown_string += f'# {video_title}\n\n'
    markdown_string += '## General Notes\n'

    for gen_note in general_notes:
        markdown_string += f'1. {gen_note[1]}\n\n'

    markdown_string += '## Timestamp Notes\n'

    for ts_note in timestamp_notes:
        # will change it to function later
        markdown_string += f'### [{ts_note[1]}]({video_url + "&t=" + str(timestamp_in_seconds(ts_note[1])) + "s"})\n'
        markdown_string += f'{ts_note[2]}\n\n'

    return markdown_string


def create_markdown_file(markdown_string, video_id):
    with open(f'mdfiles/{video_id}.md', 'w', encoding='utf8') as f:
        f.write(markdown_string)

    return (f'mdfiles/{video_id}.md')

def markdown_to_html(markdown_string):
    html = markdown.markdown(markdown_string)
    return html
