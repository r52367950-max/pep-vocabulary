"use client";

import { Component, type ReactNode } from "react";

export default class StudyBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="boot-screen" role="alert">
          <h1>这一页暂时没有打开</h1>
          <p>请重新加载后继续，已经保存的学习记录会保留。</p>
          <button className="primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      );
    return this.props.children;
  }
}
