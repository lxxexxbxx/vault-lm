# VaultLM

로컬 LLM 전용 데스크톱 앱 (Windows / macOS). 대화는 전부 암호화되어 로컬 폴더 또는 구글 드라이브에 저장되고, 어느 기기에서든 같은 패스프레이즈로 같은 맥락을 이어갑니다. Claude 앱처럼 **Chat**과 **Code**(로컬 파일을 읽고 고치는 에이전트) 모드가 분리되어 있습니다.

## 설계 요약

```
┌──────────── Tauri 앱 ─────────────────────────────────────────────┐
│ React UI (웹뷰)  ── CSP: 외부 네트워크 전면 차단, IPC만 허용         │
│      │ invoke / Channel(스트리밍)                                  │
│ Rust 코어                                                          │
│  ├ llm.rs       OpenAI 호환 SSE 클라이언트, 루프백 주소만 허용       │
│  ├ server.rs    llama-server 프로세스 관리 (127.0.0.1 강제 바인딩)   │
│  ├ crypto.rs    Argon2id + XChaCha20-Poly1305                      │
│  ├ store.rs     세션 1개 = 암호화 파일 1개, 메시지 ID 기반 병합       │
│  ├ gdrive.rs    OAuth PKCE + appDataFolder 동기화 (암호문만 업로드)  │
│  └ workspace.rs Code 모드 도구 (워크스페이스 밖 경로 차단)           │
└────────────────────────────────────────────────────────────────────┘
          │ 127.0.0.1:8080                      │ HTTPS (암호문)
     llama-server + GGUF                  Google Drive appDataFolder
```

| 결정 | 이유 |
|---|---|
| Tauri 2 (Rust + 시스템 웹뷰) | Electron 대비 설치본이 수~십여 MB, 메모리 사용이 작아 **RAM을 모델에 양보**. Win/Mac 단일 코드베이스 |
| llama.cpp `llama-server` 직접 관리 | MoE expert 오프로딩(`--n-cpu-moe`, `-ot`)을 세밀하게 제어. 프로필만 바꾸면 모델 교체 |
| OpenAI 호환 API로 추상화 | llama-server, Ollama, LM Studio 등 어떤 로컬 런타임이든 주소만 바꾸면 연결 |
| 세션당 암호화 파일 1개 | 드라이브 동기화 시 바뀐 세션만 전송. 메시지마다 고유 ID가 있어 두 기기에서 동시에 써도 병합 가능 |
| 드라이브 `drive.appdata` 권한 | 앱 전용 숨김 폴더만 접근. 내 드라이브의 다른 파일은 볼 수 없음 |

## 보안 모델 (데이터가 밖으로 나가지 않는 이유)

- **웹뷰 CSP**: `connect-src`가 IPC만 허용. UI 코드가 외부로 요청을 보내는 것 자체가 불가능합니다.
- **LLM 엔드포인트 검증**: Rust에서 `127.0.0.1` / `localhost` / `::1`만 허용. 시스템 프록시와 리다이렉트도 끔. (설정에서 켜면 사설망·Tailscale IP까지만 추가 허용)
- **llama-server 바인딩 강제**: 사용자가 `--host 0.0.0.0`을 넣어도 제거되고 항상 127.0.0.1로 실행됩니다.
- **저장 데이터 암호화**: 패스프레이즈 → Argon2id(64MiB) → 256bit 키 → XChaCha20-Poly1305. 로컬 디스크와 드라이브 모두 암호문만 존재합니다.
- **드라이브가 보는 것**: 무작위 UUID 파일명, 파일 크기, 수정 시각뿐. 제목·내용은 볼 수 없습니다.
- **키 보관**: "이 기기에서 기억"을 켜면 OS 키체인(Windows 자격 증명 관리자 / macOS 키체인)에 저장. 끄면 앱 종료 시 메모리에서 사라집니다.
- **Code 모드**: 워크스페이스 밖 경로(`..`, 절대경로, 심볼릭 링크 탈출)는 차단. 파일 쓰기·수정·명령 실행은 매번 승인 창이 뜹니다.
- 텔레메트리, 자동 업데이트, 외부 폰트·CDN 없음.

> 패스프레이즈를 잃으면 복구 방법이 없습니다.

## 1. 모델 런타임 준비

**Windows (RTX 4060)**: [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases)에서 `llama-*-bin-win-cuda-12.x-x64.zip`과 `cudart-llama-bin-win-cuda-12.x-x64.zip`을 받아 같은 폴더에 풀기.

**macOS**: `brew install llama.cpp` (Metal 가속 포함)

**모델**: Hugging Face에서 GGUF 받기. 예: `Qwen3.6-35B-A3B` 의 `Q4_K_M` (약 20GB).

## 2. 실행 / 빌드

필요: Node 20+, Rust stable, (Windows) WebView2 — Win10/11엔 기본 포함

```bash
npm install
npm run tauri dev          # 개발 실행
npm run tauri build        # 현재 OS용 설치본 생성
```

GitHub에 올린 뒤 `v0.1.0` 같은 태그를 push하면 `.github/workflows/release.yml`이 Windows(.msi/.exe)와 macOS(.dmg, Apple Silicon/Intel) 설치본을 자동으로 만듭니다.

> macOS에서 서명 없이 빌드한 앱은 처음 실행 시 "확인되지 않은 개발자" 경고가 뜹니다. 우클릭 → 열기로 실행하세요.

## 3. 처음 설정

1. 앱 실행 → 패스프레이즈로 **새 금고 만들기**
2. 설정 → **모델 서버**: llama-server 경로, GGUF 경로 지정 → "저장 후 서버 시작"
3. 왼쪽 아래 점이 초록색이 되면 사용 가능

### RTX 4060 Laptop (8GB) + RAM 32GB 권장 프로필

| 모델 | 추가 인자 | 비고 |
|---|---|---|
| Qwen3.6-35B-A3B Q4_K_M (MoE) | `-ngl 99 --n-cpu-moe 30 -fa on --jinja` | 최적. VRAM 넘치면 `--n-cpu-moe` 값을 올리고, 여유 있으면 내리기 |
| Qwen3.6-27B Q4_K_M (Dense) | `-ngl 30 -fa on --jinja` | 느림. `-ngl`을 VRAM에 맞게 조절 |
| ~9B Dense Q4 | `-ngl 99 -fa on --jinja` | VRAM에 전부 올라감, 가장 빠름 |

- `--jinja`는 Code 모드의 도구 호출(tool calling)에 필요합니다.
- 컨텍스트(`-c`)를 늘리면 KV 캐시가 VRAM을 먹으므로 `--n-cpu-moe`를 같이 올리세요.
- 설정 → 생성의 "프롬프트 예산"은 `-c`에서 `max_tokens`를 뺀 값보다 작게 두세요.

## 4. 구글 드라이브 동기화 (선택)

본인 Google Cloud 프로젝트에 OAuth 클라이언트를 만들어야 합니다 (다른 사람 앱에 토큰을 맡기지 않기 위함).

1. [Google Cloud Console](https://console.cloud.google.com/) → 새 프로젝트
2. API 및 서비스 → 라이브러리 → **Google Drive API** 사용 설정
3. OAuth 동의 화면 → 외부(External), 테스트 사용자에 본인 Gmail 추가. 범위에 `.../auth/drive.appdata` 추가
4. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 유형 **데스크톱 앱** → Client ID / Secret 복사
5. 앱 설정 → 저장소·동기화 → 입력 후 "저장 후 구글 계정 연결" → 브라우저에서 로그인

> 동의 화면이 "테스트" 상태면 refresh token이 7일 후 만료될 수 있습니다. 본인만 쓰는 경우 동의 화면을 "프로덕션으로 게시"하면 이 제한이 없어집니다 (`drive.appdata`는 민감 범위가 아니라 별도 심사 불필요).

**다른 기기에서 이어쓰기**: 앱 설치 → "드라이브에서 가져오기" → 같은 Client ID/Secret 입력 → 로그인 → 원래 패스프레이즈로 잠금 해제.

**대안 (OAuth 없이)**: 설정 → 저장소에서 금고 폴더를 *Google Drive for Desktop* 동기화 폴더 안으로 지정해도 됩니다. 파일이 이미 암호화되어 있어 안전합니다. 단 두 기기에서 동시에 같은 대화를 수정하면 드라이브 앱 쪽 충돌 사본이 생길 수 있어, 메시지 단위 병합이 되는 API 방식을 권장합니다.

## 5. 사용

- **Chat**: 일반 대화. 생각 과정(reasoning)은 접힌 상태로 표시되고, 다음 요청에는 보내지 않아 맥락을 아낍니다.
- **Code**: 새 작업 시 폴더 선택. 모델이 `list_dir`, `read_file`, `search`, `write_file`, `edit_file`, `run_command` 도구를 씁니다. 오른쪽에 파일 트리/뷰어.
- **맥락 관리**: 예산을 넘는 오래된 메시지는 자동 제외(헤더의 % 표시). "맥락 압축"을 누르면 오래된 대화를 모델이 요약해 저장하고, 이후 요청에 요약을 대신 넣습니다. 요약도 세션과 함께 동기화됩니다.

## 프로젝트 구조

```
src/                  React UI
  store.ts            상태, 대화 턴/에이전트 루프, 동기화 스케줄
  lib/context.ts      맥락 예산 계산, 요약 대상 선택
  lib/agent.ts        Code 모드 도구 정의 및 실행
  components/         Sidebar, ChatPane, CodeSide, Settings, Unlock
src-tauri/src/        Rust 코어 (위 설계 요약 참고)
```

`cd src-tauri && cargo test` 로 암호화, 병합, URL 차단 정책, 경로 탈출 차단, SSE 파싱 테스트를 실행할 수 있습니다.
