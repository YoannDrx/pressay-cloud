# Compte, administration, invitations et parrainage

Livraison du 16 septembre 2026. Base Cloud : `bc31eb1`. Le site compagnon utilise
le contrat `src/contracts/operations-wire.ts` version 1. Aucun drapeau commercial
n'est ouvert par cette migration. La revue humaine et la recette Sandbox restent
nécessaires avant activation en production.

## Fonctionnement livré

- Rôle propriétaire attribué une seule fois au compte stable associé au JWT vérifié
  de `yoann.andrieux@gmail.com`. Le singleton ne peut pas être réattribué à un
  nouveau compte portant la même adresse après suppression de l'ancien.
- Routes `/v1/admin/session`, `overview`, `users`, `users/:id`, `campaigns`,
  `campaigns/:id/revoke`, `grants/:id/revoke`, `referrals`, `rewards/:id/retry`,
  `rewards/process`, `billing/events`, `health`, `gates/:channel/:id`, `audit-log`.
  Chaque mutation exige une preuve TOTP ou code de secours signée, liée à la
  session web et datant de moins de dix minutes. Une session desktop seule ne
  donne pas de preuve administrative.
- Invitations : code aléatoire dérivé d'une clé serveur indépendante, hash SHA-256
  en base, secret affiché une seule fois ; durée Pro 1–365 jours, 30 par défaut,
  une utilisation et expiration après 30 jours par défaut. Email vérifié optionnel.
  Le rôle propriétaire est contrôlé par l'API, jamais par un champ de formulaire.
- Droits offerts séparés des abonnements. Les quotas Pro existants s'appliquent et
  le kill switch Cloud reste prioritaire. Le contrat signé desktop reste inchangé
  (`source=support`) ; les origines détaillées sont dans le registre serveur.
- Consommation atomique, verrouillage compte/campagne et unicité compte/campagne.
  Un code qui n'améliore pas l'échéance n'est pas consommé ; une tolérance d'une
  minute évite que deux codes identiques prolongent l'accès de quelques millisecondes.
- Promotions Stripe : une facture, produit Pro uniquement, montant EUR ou pourcentage,
  plafond et expiration. Le contrôle de consommation se fait à la demande depuis
  `GET /admin/campaigns/:id/usage`, sans réexposer le code secret. Les secrets ne
  figurent pas dans le journal d'audit.
- Attribution de 30 jours, premier parrain enregistré, identité vérifiée, aucun
  auto-parrainage ni abonnement Production antérieur. Les paiements réellement
  encaissés sont recherchés dans Stripe pour résister aux webhooks désordonnés.
  La date d'attribution passe exclusivement par le proxy web signé après contrôle
  du cookie ; ni un client desktop ni le proxy générique ne peuvent la choisir.
  Les factures nulles, crédits de solde seuls et marquages « payé hors ligne »
  n'accordent pas de récompense. Les événements test sont ignorés en production.
- Deux récompenses persistantes et uniques par conversion. Nature et barème figés
  à la conversion : mensualité catalogue ou arrondi(prix annuel × 30 / 365), sinon
  30 jours Pro. Un abonnement Apple actif est explicitement inéligible.
- Les remboursements annulent les récompenses en attente et révoquent les cadeaux.
  **Un crédit Stripe déjà appliqué ou d'issue incertaine passe en revue manuelle** :
  aucune écriture positive susceptible de créer une dette n'est émise automatiquement.
  Le solde Stripe ne permet pas de réserver atomiquement la portion non consommée
  d'une récompense face à une facture concurrente. Cette limite est délibérée.
- Le nettoyage de compte fonctionne avec une identité externe : données Cloud
  effacées, état `deleted` et identifiant opaque conservés pour interdire une
  recréation par un ancien JWT. Le site supprime l'identité Better Auth après avoir
  demandé ce nettoyage. Les métadonnées financières/audit ont leur cycle de
  conservation distinct ; aucune dictée locale ne figure dans cette base.

## Déploiement dans l'ordre

1. Revoir les diffs Cloud et web et les tests. Créer une branche de base isolée
   représentative de la production ; appliquer les migrations 0017 et 0018 via `bun run db:migrate`.
   `bun run db:check` doit annoncer 0018. Ne jamais modifier une migration déjà appliquée.
2. Vérifier la reprise des accès support/trial existants, les droits Stripe/Apple
   et les inscriptions sans ligne locale dans la table `user`.
3. Fournir `PRESSAY_CAMPAIGN_SECRET` (secret indépendant, au moins 32 caractères),
   `RATE_LIMIT_HMAC_SECRET`, `CRON_SECRET` et les paramètres Stripe existants.
   Garder `PRESSAY_REFERRALS_ENABLED=false` jusqu'à la recette Stripe. Les invitations
   gratuites fonctionnent sans ouverture des ventes ni activation des parrainages.
4. Déployer Cloud avant le site. Conserver les clés de signature de droits et les
   clés Better Auth existantes ; aucune rotation ni invalidation des sessions n'est
   nécessaire. Le web transmet désormais effectivement la preuve de vérification forte.
5. Déployer le site, contrôler FR/EN, retour arrière, onglets multiples, sécurité,
   accès owner/non-owner et création/consommation/révocation d'une invitation de recette.
6. Réaliser la recette Stripe Sandbox ci-dessous ; activer le programme uniquement
   après validation de ses opérations et de la capacité de la file.
7. La vente directe requiert séparément médiation, fiscalité, recette facturation,
   binaire DMG/updater et capacités Pro promises. Apple dispose de ses propres
   conditions. Mettre à jour chaque preuve/date dans `/admin/health`, puis activer
   les autorisations web/backend coordonnées. Un état « passed » ne change aucun
   drapeau opérationnel.

## File de récompenses

Le cron `GET /v1/internal/jobs/referral-rewards` utilise `CRON_SECRET` et tourne
à 04:00 UTC quotidiennement, compatible avec le planning journalier existant.
Il traite au plus dix éléments et limite le temps de travail. Il n'y a **pas de
promesse d'attribution immédiate**. Le bouton admin « Traiter un lot » permet une
exécution anticipée avec vérification forte. Pour une ouverture à plus fort volume,
qualifier une cadence supérieure dans l'offre d'hébergement réellement souscrite.

Le bail SQL dure dix minutes ; les écritures Stripe ont une clé d'idempotence par
récompense. Huit tentatives au maximum, avec quinze minutes minimum entre deux
éligibilités ; le cron quotidien peut allonger ce délai. Après 23 heures depuis
la première tentative, une écriture incertaine est mise en revue au lieu d'être
réémise. Les états `pending`, `processing`, `failed`, `review`, `applied` et
`cancelled` sont visibles dans l'admin. Une reprise admin ne réinitialise pas la
fenêtre d'idempotence. Contrôler les transactions Stripe par `pressay_reward_id`
avant toute régularisation manuelle.

Une création de campagne interrompue ne réaffiche pas le secret. Identifier la
campagne par sa clé de requête dans l'audit, la révoquer, puis en créer une nouvelle.
La révocation d'un code préserve les accès déjà accordés ; retirer un accès offert
est une action distincte et auditée.

## Recette Stripe à exécuter sur le compte Sandbox Pressay

Connexion Stripe rétablie le 16 septembre 2026. Catalogue test/live confirmé à
799 centimes mensuels et 6900 centimes annuels ; endpoints webhook actifs et
événements paiement/remboursement/litige présents. La recette ci-dessous doit être
tracée séparément des tests automatisés utilisant un double du SDK.

Un candidat de PR peut être déployé sur le projet staging canonique avec sa branche
et son SHA Git réels. Le projet production reste strictement limité à `main`.
Cela permet de tester les secrets restreints dans le runtime protégé sans les exporter.

Migration distante : 0017 validée sur une branche Neon issue de production ;
0016 et 0017 appliquées transactionnellement au staging après création d'une branche
de sauvegarde. Le staging conserve le checksum historique de 0014
`f0ad21d3db3379b18a89ee42be339cdedc5d535006a6783f0e3976d8397ef002`,
identique au fichier du commit `7ec321b`. La version ultérieure a ajouté les gardes
pour une base neuve. Aucun checksum existant n'a été réécrit : le runner normal
signale encore cette dérive historique sur cette base. Les migrations en attente
ont été exécutées avec verrou consultatif et insertion de leurs SHA actuels.

- Coupon en pourcentage puis montant EUR : portée produit, facture unique, expiration,
  plafond, codes révoqués et contrôle depuis Checkout.
- Vérifier que l'endpoint webhook reçoit `invoice.paid`, les événements d'abonnement,
  `charge.refunded`, les remboursements et litiges utilisés par le service. La
  configuration distante du webhook n'a pas été modifiée par cette livraison.
- Premier paiement positif : deux récompenses, montants figés corrects ; mensualité
  et annualité ; facture entièrement gratuite non récompensée.
- Renouvellement et webhook livré plusieurs fois : aucun crédit supplémentaire.
- Livraisons désordonnées et reprise après interruption avant/après l'écriture Stripe.
- Remboursement avant/après récompense, litige, crédits utilisés ou partiellement utilisés :
  revue manuelle explicite et aucune dette automatique.
- Isolation test/live ; Apple exclu ; aucun accès raccourci par une autre source.
- Supprimer un compte de recette, vérifier suppression de l'identité web, absence de
  résurrection par le JWT, nettoyage Stripe et révocation de l'accès Mac.

## Vérifications locales reproductibles

```sh
bun run verify
APPLE_TEST_DATABASE_URL=postgresql://.../local_test \
OPERATIONS_TEST_DATABASE_URL=postgresql://.../local_test bun run test
bunx tsx scripts/sync-web-contract.ts ../pressay-web-account-admin --check
```

Les tests PostgreSQL créent et détruisent des schémas de recette. N'utiliser que des
bases locales isolées. La migration complète a aussi été exécutée par le script
normal, rejouée sans effet supplémentaire, puis contrôlée par `db:check`.

## Retour arrière

Fermer les drapeaux parrainage et ventes en premier. Revenir à la version web
précédente si nécessaire, puis à la version Cloud précédente compatible avec 0017.
**Ne pas supprimer les tables de registre ni restaurer une base plus ancienne** :
cela perdrait les consommations et permettrait des doubles crédits. La projection
signée conserve son format et les anciennes routes restent disponibles. Les droits
accordés et les clés Stripe d'idempotence doivent être conservés pour réconciliation.
Un rollback du code de suppression de compte doit suspendre son worker, car l'ancien
worker ne sait pas terminer l'effacement d'une identité hébergée séparément.

## Recette distante achevée avant fusion

Le 16 septembre : permissions des clés restreintes test/live approuvées par le
propriétaire et enregistrées après sa vérification Stripe. Aucun secret existant
n'a été copié dans le code ni dans un nouvel environnement.

- Paiement mensuel de test EUR 7,99 : droits Pro par webhook signé, cadeau Pro
  parrain et crédit Stripe EUR 7,99 appliqués par le worker déployé.
- Réenvoi du même événement : deux récompenses au total et un seul crédit.
- Paiement annuel avec remise de 25 % : EUR 51,75 encaissés en mode test, crédit
  EUR 5,67 appliqué, calculé sur le prix annuel catalogue de EUR 69.
- Remise 100 % : facture payée à zéro, aucun paiement admissible ni récompense.
- Remboursement : cadeau révoqué, accès payé retiré, crédit déjà appliqué envoyé
  en revue manuelle. La migration 0018 corrige le cas découvert en recette où les
  notifications répétées effaçaient cet état de revue ; elle répare également les
  crédits concernés. Test de régression PostgreSQL ajouté.
- Coupons de test en pourcentage et montant fixe EUR créés avec portée produit,
  facture unique, expiration et plafond ; consommation des remises 25 % et 100 %
  vérifiée. Cela ne remplace pas une recette Checkout complète ni la validation
  des opérations sensibles dans la session administrateur finale.

Migrations 0017/0018 vérifiées sur clone Neon puis staging et production avec
contrôle des SHA et verrou transactionnel. Sauvegardes de branches conservées.
157 tests passent, dont 18 PostgreSQL réel. Les ventes demeurent fermées : la recette
commerciale complète (renouvellement, impayé, litiges, binaire et suppression depuis
le Mac), la médiation et la fiscalité restent des conditions d'ouverture distinctes.
