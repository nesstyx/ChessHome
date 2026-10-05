package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"chesshome-go/ratingsystem"
)

var db *pgxpool.Pool

type ratingRequest struct {
	WhiteRating float64 `json:"whiteRating"`
	BlackRating float64 `json:"blackRating"`
	Result      string  `json:"result"` // "white" | "black" | "draw"
}

type ratingResponse struct {
	WhiteRating int `json:"whiteRating"`
	BlackRating int `json:"blackRating"`
}

// Debug-эндпоинты /test и /dbtest УДАЛЕНЫ (аудит безопасности, пункт M5):
// они были доступны снаружи через nginx (/go/ -> 127.0.0.1:8081) и раскрывали
// служебную информацию (счётчик пользователей, страница-заглушка).

func ratingHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ratingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	var whiteScore float64
	switch req.Result {
	case "white":
		whiteScore = 1
	case "black":
		whiteScore = 0
	case "draw":
		whiteScore = 0.5
	default:
		http.Error(w, "bad result", http.StatusBadRequest)
		return
	}

	// Валидация входа: рейтинги должны быть в разумных границах — мусор
	// от кривого клиента не должен ломать Elo-расчёт.
	if req.WhiteRating < 100 || req.WhiteRating > 4000 || req.BlackRating < 100 || req.BlackRating > 4000 {
		http.Error(w, "bad rating", http.StatusBadRequest)
		return
	}

	newWhite := ratingsystem.CalculateRating(req.WhiteRating, req.BlackRating, whiteScore)
	newBlack := ratingsystem.CalculateRating(req.BlackRating, req.WhiteRating, 1-whiteScore)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ratingResponse{
		WhiteRating: int(math.Round(newWhite)),
		BlackRating: int(math.Round(newBlack)),
	})
}

type puzzleRatingRequest struct {
	PlayerRating float64 `json:"playerRating"`
	PuzzleRating float64 `json:"puzzleRating"`
	Solved       bool    `json:"solved"`
}

type puzzleRatingResponse struct {
	PlayerRating int `json:"playerRating"`
	Change       int `json:"change"`
}

func puzzleRatingHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req puzzleRatingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	var res float64
	if req.Solved {
		res = 1
	} else {
		res = 0
	}

	newRating := ratingsystem.CalculatePuzzleRating(req.PlayerRating, req.PuzzleRating, res)
	rounded := int(math.Round(newRating))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(puzzleRatingResponse{
		PlayerRating: rounded,
		Change:       rounded - int(math.Round(req.PlayerRating)),
	})
}

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("Не задана переменная окружения DATABASE_URL")
	}

	var err error
	db, err = pgxpool.New(context.Background(), dbURL)
	if err != nil {
		log.Fatal("Не удалось подключиться к базе: ", err)
	}
	defer db.Close()

	if err := db.Ping(context.Background()); err != nil {
		log.Fatal("База не отвечает на ping: ", err)
	}
	log.Println("Подключение к Postgres успешно")

	mux := http.NewServeMux()

	// БАГ (исправлен): ratingHandler существовал, но НЕ был зарегистрирован —
	// Node.js (core.js calcNewRatings) всегда падал в JS-fallback, Go-расчёт
	// Elo был мёртвым кодом.
	mux.HandleFunc("/api/rating/calculate", ratingHandler)
	mux.HandleFunc("/api/rating/puzzle/calculate", puzzleRatingHandler)

	nodeURL, _ := url.Parse("http://127.0.0.1:10000")
	proxy := httputil.NewSingleHostReverseProxy(nodeURL)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	})

	port := os.Getenv("GO_PORT")
	if port == "" {
		port = "8081"
	}

	log.Printf("Go-сервис слушает 127.0.0.1:%s\n", port)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+port, mux))
}
