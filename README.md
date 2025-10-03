> [日本語版はこちら](#japanese-version) (Japanese version follows below)
---

# Yuzuha - Advanced Conversational AI for Slack

## 🌟 Overview
A sophisticated, serverless conversational AI agent built on Google Apps Script and powered by the Google Gemini API. This bot features a dynamic, multi-faceted personality, long-term memory, and a suite of tools for interacting with users and external services in a stable, resilient, and context-aware manner.

## ✨ Key Features
- **Dynamic Personality Engine:**
    - Utilizes a detailed prompt architecture with a "Dossier" system (via Google Sheets) to define unique relationships and tones for individual users.
    - Features a toggleable Relationship Score system for granular, mood-based responses.

- **Advanced Conversational Logic:**
    - A robust "Etiquette Brain" navigates complex, multi-user thread conversations.
    - Includes a "Context Reset Protocol" to prevent emotional or stylistic bleeding between different users in the same thread.
    - Supports a bot-to-bot "conversation chain" protocol.
    - Features a "Ghost Mode" for proactive, unprompted interjections in designated channels.

- **Intelligent Tool Agent (Function Calling):**
    - Autonomously uses external tools to answer questions and perform tasks.
    - **Tools Include:** Web Search (Google), Webpage Reading, Current Date/Time, and a full Long-Term Memory suite.

- **Multi-Modal Image Processing:**
    - Capable of receiving and analyzing images.
    - Uses Google Vision API for general image recognition.
    - Features a persistent Image Memory (via Cloudinary pHash & Google Sheets) to recognize specific characters across different images.

- **Resiliency & Stability:**
    - Implements an API retry-logic in the core `callGeminiAPI` function to handle transient network errors.
    - Includes a "Sanity Check Protocol" to detect and recover from stale or corrupt data returned by the Slack API, preventing crashes and nonsensical replies.

## 🛠️ Tech Stack & APIs
- **Core Language:** JavaScript (Google Apps Script)
- **Platform:** Google Apps Script (Serverless)
- **AI Model:** Google Gemini
- **APIs:** Slack API, Google Sheets API, Google Vision API, Google Custom Search API, Cloudinary API

## 🚀 Architecture & Deployment
This bot is deployed as a Google Apps Script web app, triggered by Slack Event API webhooks. All logic, state management, and API integrations are handled within the serverless GAS environment.

---

<a name="japanese-version"></a>
# 柚葉 - Slack向け高度対話型AIボット

## 🌟 概要
Google Apps Script上で構築され、Google Gemini APIを搭載した、高機能なサーバーレス対話型AIエージェントです。このボットは、動的で多面的なペルソナ、長期記憶、そして外部サービスと連携するためのツール群を特徴としています。

## ✨ 主な機能
- **動的ペルソナエンジン:**
    - 詳細なプロンプトアーキテクチャと「Dossier」システム（Google Sheets経由）を利用し、個々のユーザーに対する独自の口調や関係性を定義。
    - オン/オフ可能な関係性スコアシステムにより、細かな気分に基づいた応答を実現。

- **高度な会話ロジック:**
    - 堅牢な「エチケットブレイン」が、複数人が参加する複雑なスレッド会話を制御。
    - 「コンテキストリセット・プロトコル」により、スレッド内で異なるユーザー間の感情や文体の「ブリーディング（混線）」を防止。
    - ボット同士の「会話連鎖」プロトコルに対応。
    - 指定されたチャンネルで自発的に会話に介入する「ゴーストモード」を搭載。

- **インテリジェント・ツールエージェント:**
    - 質問への回答やタスク実行のために、自律的に外部ツールを使用。
    - **搭載ツール:** Web検索 (Google), Webページ読込, 現在日時取得, 長期記憶（記憶・再生・忘却）。

- **マルチモーダル画像処理:**
    - 画像の受信と分析に対応。
    - Google Vision APIによる汎用的な画像認識。
    - 永続的な画像記憶（Cloudinary pHash & Google Sheets経由）により、異なる画像でも特定のキャラクターを認識。

- **安定性と回復力:**
    - `callGeminiAPI`コア関数にAPIリトライロジックを実装し、一時的なネットワークエラーに対応。
    - 「サニティチェック・プロトコル」により、Slack APIから返される古い、または破損したデータを検知・回復し、クラッシュや無意味な応答を防止。

## 🛠️ 技術スタック・使用API
- **主要言語:** JavaScript (Google Apps Script)
- **プラットフォーム:** Google Apps Script (サーバーレス)
- **AIモデル:** Google Gemini
- **使用API:** Slack API, Google Sheets API, Google Vision API, Google Custom Search API, Cloudinary API

## 🚀 アーキテクチャとデプロイ
このボットはGoogle Apps Scriptのウェブアプリケーションとしてデプロイされ、Slack Event APIのWebhookによってトリガーされます。全てのロジック、状態管理、API連携はサーバーレスなGAS環境内で処理されます。
