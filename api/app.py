# add flask boilerplate
from flask import Flask, jsonify, request
from flask_cors import CORS


app = Flask(__name__)
CORS(app)

# add a route
@app.route('/')
def hello_world():
    return jsonify({'message': 'Hello, World!'})


# add a route
@app.route('/saveNotes', methods=['POST'])
def saveNotes():
    # print the input data
    data = request.get_json()
    print(data)

    # add your backend code here to save the notes
    # ...

    # return a success response
    return jsonify({'success': True})



# run the Flask app
if __name__ == "__main__":
    app.run(debug=True)

    