# ScriptWoocommerceToPrestashop

Script que j'ai créé pour charger les produits créer sous un wooCommerce vers un prestashop 9. Il utilise l'export XML de wordPress et l'API webservice de prestashop 9.

Au stade du dernier commit, il y a un petit bug l'état du prduit est à 0 et il n'apparait pas dans le BO.

sql de correction : UPDATE 4p9tb_product SET state = 1 WHERE state = 0;
