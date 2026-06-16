import app from "./app";

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!process.env.FOOTBALL_API_KEY) {
    console.log("No FOOTBALL_API_KEY set — using mock data");
  }
});
