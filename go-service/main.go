package main

import (
        "encoding/json"
        "log"
        "math"
        "net/http"
        "os"

        "chesshome-go/ratingsystem"
)

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

// Подключение к PostgreSQL УДАЛЕНО (мёртвый код): ни ratingHandler, ни
// другие обработчики к базе не обращаются — пул соединений простаивал,
// а без DATABASE_URL сервис вообще падал при старте и блокировал расчёт
// рейтингов. Зависимость github.com/jackc/pgx/v5 убрана из go.mod/vendor.

// Эндпоинт /api/rating/puzzle/calculate и puzzleRatingHandler УДАЛЕНЫ:
// расчёт рейтинга задач выполняется нативно в Node (routes.js,
// ratingDelta = correct ? 15 : -10) — потребителей у эндпоинта не было.

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

func main() {
        mux := http.NewServeMux()

        // БАГ (исправлен): ratingHandler существовал, но НЕ был зарегистрирован —
        // Node.js (core.js calcNewRatings) всегда падал в JS-fallback, Go-расчёт
        // Elo был мёртвым кодом.
        mux.HandleFunc("/api/rating/calculate", ratingHandler)

        // Обратный прокси УДАЛЁН (P2): раньше catch-all "/" прогонял через Go
        // ВЕСЬ трафик Node (httputil.NewSingleHostReverseProxy) — лишний хоп,
        // дублирование функциональности nginx, размытие ответственности и
        // разрастание поверхности атаки. Теперь Go занимается ТОЛЬКО API
        // расчёта рейтингов; весь HTTP/статика — по-прежнему nginx -> Node.

        port := os.Getenv("GO_PORT")
        if port == "" {
                port = "8081"
        }

        log.Printf("Go-сервис слушает 127.0.0.1:%s\n", port)
        log.Fatal(http.ListenAndServe("127.0.0.1:"+port, mux))
}
