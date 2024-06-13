FROM python:3-alpine3.15

WORKDIR /app

COPY ./server /app

RUN pip install -r requirements.txt

CMD gunicorn --bind 0.0.0.0:5000 --log-level=debug wsgi:app