const stepContent = [
  {
    status: "入力",
    kicker: "要件",
    title: "注文詳細画面から、注文をキャンセルできるようにしたい。",
    description: "この要件が触れる実装面をたどり、根拠と未確定の判断を段階ごとに整理します。",
    label: "入力された要件",
    detailKind: "text",
    detail: "注文詳細画面から、注文をキャンセルできるようにしたい。",
  },
  {
    status: "対象範囲を限定",
    kicker: "関連する実装面",
    title: "要件に関連する実装面を限定する。",
    description: "プロジェクト全体を要約せず、UI、API、Controller、Service と周辺機能のうち、この変更に必要な Context だけを対象にします。",
    label: "概念上の実装面",
    detailKind: "path",
    detail: ["Order Detail", "Cancel API", "Controller", "Service"],
  },
  {
    status: "観測済み",
    kicker: "Project Context からの観測",
    title: "返金機能、在庫予約、Audit Log の既存実装を、根拠とともに確認する。",
    description: "存在が確認できる機能は事実として記録します。ただし「存在する」ことを「今回使うべき」という仕様判断には変換しません。",
    label: "観測済み",
    detailKind: "tags",
    detail: ["返金 capability", "在庫予約", "Audit Log"],
  },
  {
    status: "未決定",
    kicker: "人の判断が必要",
    title: "返金方針、権限、在庫解放のタイミングは、コードだけでは決められない。",
    description: "追加調査で判明する事実と、責任者が決めるべき事項を区別します。根拠が途切れた場所を、妥当そうな仮定で埋めません。",
    label: "Context Gap",
    detailKind: "tags",
    detail: ["返金ポリシー", "キャンセル権限", "在庫解放タイミング"],
  },
  {
    status: "合意済み",
    kicker: "合意された判断",
    title: "プロジェクト上の権限を持つ人が、未確定事項を具体的に決定する。",
    description: "回答は会話のまま流さず、どの Gap に対する誰の判断かが分かる形で、実装 Context に組み込みます。",
    label: "Human Alignment",
    detailKind: "text",
    detail: "未決定事項と、人が決めた仕様を対応づける。",
  },
  {
    status: "引き継ぎ可能",
    kicker: "Coding Agent への引き継ぎ",
    title: "根拠と決定済み事項を、実装可能な小さな Context として引き継ぐ。",
    description: "Coding Agent は、ビジネス判断を再推論する代わりに、対象範囲と決定が明確になった実装へ集中できます。Forge はその前段を担当します。",
    label: "Implementation Package",
    detailKind: "tags",
    detail: ["根拠", "決定済み仕様", "変更対象", "テスト意図"],
  },
];

const stepper = document.querySelector("[data-stepper]");

if (stepper) {
  const buttons = [...stepper.querySelectorAll("[data-step]")];
  const index = stepper.querySelector("[data-step-index]");
  const status = stepper.querySelector("[data-step-status]");
  const kicker = stepper.querySelector("[data-step-kicker]");
  const title = stepper.querySelector("[data-step-title]");
  const description = stepper.querySelector("[data-step-description]");
  const detail = stepper.querySelector("[data-step-detail]");

  const activateStep = (position) => {
    const content = stepContent[position];

    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === position;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });

    index.textContent = `STEP ${String(position + 1).padStart(2, "0")}`;
    status.textContent = content.status;
    kicker.textContent = content.kicker;
    title.textContent = content.title;
    description.textContent = content.description;
    const detailLabel = document.createElement("span");
    detailLabel.textContent = content.label;
    detail.replaceChildren(detailLabel);

    if (content.detailKind === "path") {
      const path = document.createElement("div");
      path.className = "conceptual-path";
      content.detail.forEach((item, itemIndex) => {
        const node = document.createElement("b");
        node.textContent = item;
        path.append(node);
        if (itemIndex < content.detail.length - 1) {
          const arrow = document.createElement("i");
          arrow.textContent = "→";
          path.append(arrow);
        }
      });
      detail.append(path);
    } else if (content.detailKind === "tags") {
      const tags = document.createElement("div");
      tags.className = "conceptual-tags";
      content.detail.forEach((item) => {
        const tag = document.createElement("b");
        tag.textContent = item;
        tags.append(tag);
      });
      detail.append(tags);
    } else {
      const text = document.createElement("p");
      text.textContent = content.detail;
      detail.append(text);
    }
  };

  buttons.forEach((button, position) => {
    button.addEventListener("click", () => activateStep(position));
    button.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = position;
      if (event.key === 'ArrowLeft') next = (position - 1 + buttons.length) % buttons.length;
      if (event.key === 'ArrowRight') next = (position + 1) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      activateStep(next);
      buttons[next].focus();
    });
  });

  activateStep(0);
}

const comparison = document.querySelector("[data-comparison]");

if (comparison) {
  const tabs = [...comparison.querySelectorAll("[data-comparison-tab]")];
  const panels = [...comparison.querySelectorAll("[data-comparison-panel]")];

  const activateComparison = (name) => {
    tabs.forEach((tab) => {
      const active = tab.dataset.comparisonTab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.comparisonPanel !== name;
    });
  };

  tabs.forEach((tab, position) => {
    tab.addEventListener("click", () => activateComparison(tab.dataset.comparisonTab));
    tab.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'ArrowRight' ? (position + 1) % tabs.length : (position - 1 + tabs.length) % tabs.length;
      activateComparison(tabs[next].dataset.comparisonTab);
      tabs[next].focus();
    });
  });

  activateComparison("without");
}
