from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier
from sklearn.metrics import accuracy_score

# Load dataset
iris = load_iris()
X = iris.data
y = iris.target

# Split data
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42)

# ANN Model (MLP = Neural Network)
model = MLPClassifier(
    hidden_layer_sizes=(8,),
    max_iter=1000,
    random_state=42)

# Train model
model.fit(X_train, y_train)

# Predict
y_pred = model.predict(X_test)

# Accuracy
acc = accuracy_score(y_test, y_pred)
print("Actual:     ", y_test)
print("Predicted:  ", y_pred)
print("Accuracy:   ", acc * 100, "%")

# New sample prediction
sample = [[5.1, 3.5, 1.4, 0.2]]
pred = model.predict(sample)
print("\nPrediction for new sample:")
if pred[0] == 0:
    print("Setosa")
elif pred[0] == 1:
    print("Versicolor")
else:
    print("Virginica")
